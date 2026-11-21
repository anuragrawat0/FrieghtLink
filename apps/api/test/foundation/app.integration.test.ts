import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { io, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import { authRateLimit } from "../../src/plugins/rate-limit.js";
import { AppError } from "../../src/shared/errors.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const ownerId = randomUUID();
const carrierId = randomUUID();
const otherId = randomUUID();
const adminId = randomUUID();
const carrierProfileId = randomUUID();
const loadId = randomUUID();
const bidId = randomUUID();
const shipmentId = randomUUID();
const clients = new Set<Socket>();
const webOrigin = "http://localhost:3000";
const jwtSecret = randomBytes(32).toString("hex");
let uploadDir: string;
let app: ReturnType<typeof buildApp>;
let address: string;
let fixturesCreated = false;

beforeAll(async () => {
  const databaseUrl = requireTestDatabaseUrl();
  uploadDir = await mkdtemp(join(tmpdir(), "freightlink-api-test-"));
  app = buildApp(readConfig({ NODE_ENV: "test", DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret, UPLOAD_DIR: uploadDir }), async (routes) => {
    routes.post("/limit-check-a", { config: { rateLimit: authRateLimit } }, () => ({ data: true }));
    routes.post("/limit-check-b", { config: { rateLimit: authRateLimit } }, () => ({ data: true }));
    routes.post("/multipart-check", async (request) => {
      let saved: Awaited<ReturnType<typeof routes.uploads.save>> | undefined;
      let clientEventId: unknown;
      for await (const part of request.parts()) {
        if (part.type === "file") saved = await routes.uploads.save("pod", part.file);
        else if (part.fieldname === "clientEventId") clientEventId = part.value;
      }
      if (!saved) throw new AppError(400, "VALIDATION_ERROR", "A file is required.");
      return { data: { ...saved, clientEventId } };
    });
  });
  address = await app.listen({ host: "127.0.0.1", port: 0 });

  await app.prisma.$transaction(async (tx) => {
    for (const [id, role] of [[ownerId, "SHIPPER"], [carrierId, "CARRIER"], [otherId, "SHIPPER"], [adminId, "ADMIN"]] as const) {
      await tx.user.create({ data: { id, role, email: `${id}@example.invalid`, displayName: role, passwordHash: "fixture-only" } });
    }
    await tx.carrierProfile.create({ data: { id: carrierProfileId, userId: carrierId, verificationStatus: "APPROVED" } });
    await tx.load.create({ data: {
      id: loadId, shipperId: ownerId, status: "ASSIGNED", description: "Test freight",
      pickupCity: "Columbus", pickupRegion: "IN", pickupLat: 39.2014, pickupLng: -85.9214,
      deliveryCity: "Camden", deliveryRegion: "IN", deliveryLat: 40.64, deliveryLng: -86.1581,
      pickupReadyAt: new Date("2026-12-01T10:00:00.000Z"), deliveryBy: new Date("2026-12-01T16:00:00.000Z"),
    } });
    await tx.bid.create({ data: { id: bidId, loadId, carrierProfileId, status: "ACCEPTED" } });
    await tx.bidOffer.create({ data: { bidId, revision: 1, authorUserId: carrierId, amountCents: 115000 } });
    await tx.shipment.create({ data: { id: shipmentId, loadId, acceptedBidId: bidId, acceptedRevision: 1, carrierProfileId, acceptedRateCents: 115000 } });
  });
  fixturesCreated = true;
}, 20_000);

afterEach(() => {
  for (const client of clients) client.disconnect();
  clients.clear();
  vi.restoreAllMocks();
});

afterAll(async () => {
  try {
    if (fixturesCreated) {
      await app.prisma.$transaction([
        app.prisma.shipment.deleteMany({ where: { id: shipmentId } }),
        app.prisma.bidOffer.deleteMany({ where: { bidId } }),
        app.prisma.bid.deleteMany({ where: { id: bidId } }),
        app.prisma.load.deleteMany({ where: { id: loadId } }),
        app.prisma.carrierProfile.deleteMany({ where: { id: carrierProfileId } }),
        app.prisma.user.deleteMany({ where: { id: { in: [ownerId, carrierId, otherId, adminId] } } }),
      ]);
    }
  } finally {
    try {
      await app?.close();
    } finally {
      if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
    }
  }
});

async function connect(token: string) {
  const client = io(address, {
    autoConnect: false, forceNew: true, reconnection: false, timeout: 2000, transports: ["websocket"],
    auth: { token }, extraHeaders: { Origin: webOrigin },
  });
  clients.add(client);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
    client.connect();
  });
  return client;
}

it("uses the health envelope for PostgreSQL success and failure", async () => {
  const ready = await app.inject("/api/v1/health");
  expect(ready.statusCode).toBe(200);
  expect(ready.json()).toEqual({ data: { status: "ok" } });
  expect((await app.inject("/health")).json()).toEqual(ready.json());
  const invalid = await app.inject("/api/v1/health?diagnostics=true");
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", requestId: expect.any(String) } });

  vi.spyOn(app.prisma, "$queryRaw").mockRejectedValueOnce(new Error("private database details"));
  const unavailable = await app.inject("/api/v1/health");
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json()).toEqual({ error: {
    code: "SERVICE_UNAVAILABLE", message: "The database is unavailable.", requestId: expect.any(String),
  } });
});

it("limits opted-in routes independently", async () => {
  for (let request = 0; request < 10; request++) {
    expect((await app.inject({ method: "POST", url: "/api/v1/limit-check-a" })).statusCode).toBe(200);
  }
  const unscheduled = await app.inject({ method: "POST", url: "/api/v1/limit-check-a" });
  expect(unscheduled.statusCode).toBe(429);
  expect(unscheduled.json()).toMatchObject({ error: { code: "RATE_LIMITED", requestId: expect.any(String) } });
  expect((await app.inject({ method: "POST", url: "/api/v1/limit-check-b" })).statusCode).toBe(200);
  expect((await app.inject("/api/v1/health")).statusCode).toBe(200);
});

it("uses multipart signatures rather than client filenames or content types", async () => {
  const boundary = "freightlink-test-boundary";
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const clientEventId = randomUUID();
  const response = await app.inject({
    method: "POST", url: "/api/v1/multipart-check",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="claim.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      jpeg,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="clientEventId"\r\n\r\n${clientEventId}\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ data: { mimeType: "image/jpeg", sizeBytes: jpeg.length, clientEventId } });
  expect(response.json().data.storageKey).not.toContain("claim.pdf");
});

it("uses current shipment ownership for subscriptions and emits only to the intended rooms", async () => {
  await expect(connect("invalid-token")).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
  const [owner, carrier, other, admin] = await Promise.all([ownerId, carrierId, otherId, adminId].map(async (id) => connect(await app.auth.signAccessToken(id))));
  await expect(other.timeout(2000).emitWithAck("shipment:subscribe", { shipmentId })).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  await expect(owner.timeout(2000).emitWithAck("shipment:subscribe")).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  await expect(owner.timeout(2000).emitWithAck("shipment:subscribe", { shipmentId, extra: true })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  for (const client of [owner, carrier, admin]) {
    await expect(client.timeout(2000).emitWithAck("shipment:subscribe", { shipmentId: shipmentId.toUpperCase() })).resolves.toEqual({ ok: true });
  }
  const received = [owner, carrier, admin].map((client) => new Promise((resolve) => client.once("shipment:updated", resolve)));
  const otherUpdate = vi.fn();
  other.on("shipment:updated", otherUpdate);
  const update = { shipmentId, status: "ASSIGNED" as const, checkpointId: randomUUID(), sequence: 1, currentEtaAt: null };
  app.emitToShipment(shipmentId, "shipment:updated", update);
  expect(await Promise.all(received)).toEqual([update, update, update]);

  const assigned = { shipmentId, loadId, bidId, status: "ASSIGNED" as const };
  const otherNotice = new Promise((resolve) => other.once("load:assigned", resolve));
  app.emitToUser(otherId, "load:assigned", assigned);
  expect(await otherNotice).toEqual(assigned);
  expect(otherUpdate).not.toHaveBeenCalled();
  await expect(owner.timeout(2000).emitWithAck("shipment:unsubscribe", { shipmentId })).resolves.toEqual({ ok: true });
  expect(app.io.sockets.adapter.rooms.get(`shipment:${shipmentId}`)).not.toContain(owner.id);
  expect(app.io.sockets.adapter.rooms.get(`shipment:${shipmentId}`)).toContain(carrier.id);
});

it("disconnects at token expiry", async () => {
  const expiry = Math.floor(Date.now() / 1000) + 3;
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" })
    .setSubject(ownerId).setIssuedAt(expiry - 3600).setExpirationTime(expiry)
    .setIssuer("freightlink-api").setAudience("freightlink-web").sign(new TextEncoder().encode(jwtSecret));
  const client = await connect(token);
  await expect(new Promise((resolve) => client.once("disconnect", resolve))).resolves.toBe("io server disconnect");
});

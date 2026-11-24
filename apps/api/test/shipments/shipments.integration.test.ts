import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import type { Role } from "../../src/generated/prisma/client.js";
import * as billing from "../../src/modules/billing/service.js";
import type { CheckpointInput } from "../../src/modules/shipments/tracking.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const prefix = `tracking-${randomUUID()}-`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLYAAAAAASUVORK5CYII=", "base64");
const assignedAt = Date.parse("2026-01-01T00:00:00.000Z");
let app: ReturnType<typeof buildApp>;
let uploadDir: string;

beforeAll(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), "freightlink-pod-"));
  app = buildApp(readConfig({
    NODE_ENV: "test", DATABASE_URL: requireTestDatabaseUrl(), JWT_SECRET: randomUUID(), UPLOAD_DIR: uploadDir,
  }));
  await app.ready();
});

afterAll(async () => {
  try {
    if (app?.prisma) {
      const email = { startsWith: prefix };
      const load = { shipper: { email } };
      const shipment = { load };
      await app.prisma.detentionCharge.deleteMany({ where: { invoice: { shipment } } });
      await app.prisma.invoice.deleteMany({ where: { shipment } });
      await app.prisma.proofOfDelivery.deleteMany({ where: { shipment } });
      await app.prisma.trackingCheckpoint.deleteMany({ where: { shipment } });
      await app.prisma.shipment.deleteMany({ where: { load } });
      await app.prisma.bidOffer.deleteMany({ where: { bid: { load } } });
      await app.prisma.bid.deleteMany({ where: { load } });
      await app.prisma.load.deleteMany({ where: load });
      await app.prisma.carrierProfile.deleteMany({ where: { user: { email } } });
      await app.prisma.user.deleteMany({ where: { email } });
    }
  } finally {
    await app?.close();
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  }
});

async function account(role: Role) {
  const user = await app.prisma.user.create({ data: {
    email: `${prefix}${randomUUID()}@example.test`, role, displayName: role, passwordHash: "fixture",
  } });
  if (role === "CARRIER") await app.prisma.carrierProfile.create({ data: { userId: user.id, verificationStatus: "APPROVED" } });
  return { id: user.id, authorization: `Bearer ${await app.auth.signAccessToken(user.id)}` };
}

type Account = Awaited<ReturnType<typeof account>>;
function request(user: Account, path: string, payload?: object) {
  return app.inject({ method: payload ? "POST" : "GET", url: "/api/v1" + path,
    headers: { authorization: user.authorization }, payload });
}

function event(kind: CheckpointInput["kind"], minutes: number, fields: Partial<CheckpointInput> = {}): CheckpointInput {
  return { kind, clientEventId: randomUUID(), occurredAt: new Date(assignedAt + minutes * 60_000).toISOString(), ...fields };
}

function pod(user: Account, path: string, key: string, photo = png) {
  const boundary = "freightlink-test-pod";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pod.png"\r\nContent-Type: image/png\r\n\r\n`),
    photo, Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="clientEventId"\r\n\r\n${key}\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: "POST", url: `/api/v1${path}/pod`, payload, headers: {
    authorization: user.authorization, "content-type": `multipart/form-data; boundary=${boundary}`,
  } });
}

async function assignment() {
  const shipper = await account("SHIPPER");
  const carrier = await account("CARRIER");
  const load = await app.prisma.load.create({ data: {
    shipperId: shipper.id, status: "OPEN", description: "Tracking test load", pickupCity: "Pickup", pickupRegion: "NY",
    pickupLat: 0, pickupLng: 0, deliveryCity: "Delivery", deliveryRegion: "MA", deliveryLat: 0, deliveryLng: 1,
    pickupReadyAt: new Date(assignedAt), deliveryBy: new Date(assignedAt + 86_400_000),
  } });
  const bid = await request(carrier, `/loads/${load.id}/bids`, { amountCents: 115_000 });
  expect(bid.statusCode, bid.body).toBe(201);
  const accepted = await request(shipper, `/bids/${bid.json().data.id}/accept`, { expectedRevision: 1 });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const id = accepted.json().data.shipment.id as string;
  await app.prisma.shipment.update({ where: { id }, data: { assignedAt: new Date(assignedAt) } });
  await app.prisma.trackingCheckpoint.update({
    where: { shipmentId_sequence: { shipmentId: id, sequence: 1 } }, data: { occurredAt: new Date(assignedAt) },
  });
  return { shipper, carrier, load, id, path: `/shipments/${id}`, track: `/shipments/${id}/checkpoints` };
}

it("scopes shipment reads and enforces checkpoint order, input, time, replay, and ETA", async () => {
  const { shipper, carrier, load, path, track } = await assignment();
  const outsider = await account("CARRIER");
  const otherShipper = await account("SHIPPER");
  const admin = await account("ADMIN");
  const arrival = event("PICKUP_ARRIVAL", 1);
  for (const reader of [shipper, carrier, admin]) {
    const detail = await request(reader, path);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data).toMatchObject({ load: { id: load.id }, proofOfDelivery: null, invoiceId: null, status: "ASSIGNED" });
    expect((await request(reader, `/shipments?loadId=${load.id}&status=ASSIGNED&limit=1`)).json().data).toEqual(
      [expect.objectContaining({ loadId: load.id })],
    );
    expect((await request(reader, `/shipments?loadId=${randomUUID()}`)).json().data).toEqual([]);
  }
  for (const reader of [otherShipper, outsider]) {
    expect((await request(reader, path)).statusCode).toBe(404);
    expect((await request(reader, track)).statusCode).toBe(404);
    expect((await request(reader, `/shipments?loadId=${load.id}`)).json().data).toEqual([]);
  }
  expect((await app.inject({ url: "/api/v1" + path })).statusCode).toBe(401);
  expect((await request(shipper, "/shipments?loadId=abc")).statusCode).toBe(400);
  expect((await request(outsider, track, arrival)).statusCode).toBe(404);
  expect((await request(shipper, track, arrival)).statusCode).toBe(403);
  const wrongOrder = await request(carrier, track, event("PICKED_UP", 2));
  expect(wrongOrder.statusCode).toBe(409);
  expect(wrongOrder.json().error.code).toBe("INVALID_SHIPMENT_TRANSITION");
  for (const input of [
    event("GPS", 2), event("GPS", 2, { latitude: 0 }), event("GPS", 2, { latitude: 91, longitude: 0 }),
    { ...event("GPS", 2), latitude: "0", longitude: 0 },
    { ...arrival, latitude: null, longitude: null }, { ...arrival, longitude: 0 }, { ...arrival, extra: true },
  ]) expect((await request(carrier, track, input)).statusCode).toBe(400);
  expect((await request(carrier, track, { ...arrival, occurredAt: new Date(Date.now() + 60_000).toISOString() })).statusCode).toBe(422);

  const emit = vi.spyOn(app, "emitToShipment");
  try {
    const pickupArrival = await request(carrier, track, arrival);
    expect(pickupArrival.statusCode, pickupArrival.body).toBe(201);
    expect(pickupArrival.json().data.shipment.currentEtaAt).toBeNull();
    const backwards = await request(carrier, track, event("PICKED_UP", 0));
    expect(backwards.statusCode, backwards.body).toBe(422);
    expect(backwards.json().error.code).toBe("INVALID_CHECKPOINT_TIME");
    const pickedUp = await request(carrier, track, event("PICKED_UP", 2));
    expect(pickedUp.statusCode, pickedUp.body).toBe(201);
    expect(pickedUp.json().data.shipment).toMatchObject({ status: "IN_TRANSIT", currentEtaAt: "2026-01-01T01:45:00.000Z" });
    const gpsInput = event("GPS", 3, { latitude: 0, longitude: 0.5 });
    const gps = await request(carrier, track, gpsInput);
    expect(gps.statusCode, gps.body).toBe(201);
    expect(gps.json().data.shipment.currentEtaAt).toBe("2026-01-01T00:55:00.000Z");
    const reached = await request(carrier, track, event("DELIVERY_ARRIVAL", 4));
    expect(reached.statusCode, reached.body).toBe(201);
    expect(reached.json().data.shipment.currentEtaAt).toBe("2026-01-01T00:04:00.000Z");
    expect((await request(carrier, track, event("GPS", 5, { latitude: 0, longitude: 1 }))).statusCode).toBe(409);
    const replay = await request(carrier, track, { ...gpsInput, clientEventId: gpsInput.clientEventId.toUpperCase() });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data).toEqual({ shipment: reached.json().data.shipment, checkpoint: gps.json().data.checkpoint });
    const conflict = await request(carrier, track, { ...gpsInput, longitude: 1 });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("EVENT_KEY_REUSED");
    const timeline = await request(shipper, `${track}?limit=2&offset=2`);
    expect(timeline.json()).toMatchObject({ data: [{ sequence: 3 }, { sequence: 4 }], meta: { limit: 2, offset: 2, hasMore: true } });
    expect(emit).toHaveBeenCalledTimes(4);
    expect(emit).toHaveBeenLastCalledWith(reached.json().data.shipment.id, "shipment:updated", expect.objectContaining({
      sequence: 5, checkpointId: reached.json().data.checkpoint.id, currentEtaAt: "2026-01-01T00:04:00.000Z",
    }));
  } finally {
    emit.mockRestore();
  }
});

it("retries competing appends and records an identical event once", async () => {
  const { carrier, track } = await assignment();
  const input = event("PICKUP_ARRIVAL", 1);
  const [first, second] = await Promise.all([request(carrier, track, input), request(carrier, track, input)]);
  expect([first.statusCode, second.statusCode].sort(), first.body + second.body).toEqual([200, 201]);
  expect(first.json()).toEqual(second.json());
  const timeline = await request(carrier, track);
  expect(timeline.json().data.map(({ sequence }: { sequence: number }) => sequence)).toEqual([1, 2]);
});

it("completes POD and invoice together, cleans up failures, and replays concurrent retries", async () => {
  const { carrier, shipper, id, load, path, track } = await assignment();
  const outsider = await account("CARRIER");
  const key = randomUUID();
  const files = await readdir(uploadDir);
  const podPath = `${path}/pod/file`;
  expect((await request(shipper, podPath)).statusCode).toBe(404);
  expect((await pod(outsider, path, key)).statusCode).toBe(404);
  expect((await pod(shipper, path, key)).statusCode).toBe(403);
  const early = await pod(carrier, path, key);
  expect(early.statusCode, early.body).toBe(409);
  expect(early.json().error.code).toBe("INVALID_SHIPMENT_TRANSITION");
  expect(await readdir(uploadDir)).toEqual(files);

  for (const input of [event("PICKUP_ARRIVAL", 1), event("PICKED_UP", 151), event("DELIVERY_ARRIVAL", 152)]) {
    const response = await request(carrier, track, input);
    expect(response.statusCode, response.body).toBe(201);
  }
  expect((await pod(carrier, path, "invalid")).statusCode).toBe(400);
  expect((await pod(carrier, path, key, Buffer.from("%PDF-test"))).statusCode).toBe(415);
  expect((await pod(carrier, path, key, Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]))).statusCode).toBe(413);
  expect(await readdir(uploadDir)).toEqual(files);

  const shipmentEvent = vi.spyOn(app, "emitToShipment");
  const userEvent = vi.spyOn(app, "emitToUser");
  const issueInvoice = billing.issueInvoice;
  const issuance = vi.spyOn(billing, "issueInvoice").mockImplementationOnce((tx, input) =>
    issueInvoice(tx, { ...input, linehaulCents: 0 }));
  try {
    const failed = await pod(carrier, path, key);
    expect(failed.statusCode, failed.body).toBe(500);
    expect(issuance).toHaveBeenCalledOnce();
    expect(shipmentEvent).not.toHaveBeenCalled();
    expect(userEvent).not.toHaveBeenCalled();
    expect(await readdir(uploadDir)).toEqual(files);
    expect((await request(shipper, path)).json().data).toMatchObject({
      load: { status: "ASSIGNED" }, status: "IN_TRANSIT", deliveredAt: null, currentEtaAt: "2026-01-01T02:32:00.000Z",
      proofOfDelivery: null, invoiceId: null,
    });
    expect((await request(carrier, track)).json().data.at(-1).kind).toBe("DELIVERY_ARRIVAL");
    issuance.mockRestore();

    const [first, second] = await Promise.all([pod(carrier, path, key), pod(carrier, path, key)]);
    expect([first.statusCode, second.statusCode].sort(), first.body + second.body).toEqual([200, 201]);
    expect(first.json()).toEqual(second.json());
    const { shipment, checkpoint, proofOfDelivery, invoice } = first.json().data;
    expect(shipment).toMatchObject({ status: "DELIVERED", currentEtaAt: null, deliveredAt: checkpoint.occurredAt });
    expect(checkpoint).toMatchObject({ kind: "DELIVERED", clientEventId: key, sequence: 5, actorUserId: carrier.id });
    expect(proofOfDelivery).toMatchObject({ uploadedAt: checkpoint.occurredAt, mimeType: "image/png", sizeBytes: png.length });
    expect(proofOfDelivery).not.toHaveProperty("storageKey");
    expect(proofOfDelivery).not.toHaveProperty("sha256");
    expect(invoice).toMatchObject({ status: "ISSUED", currency: "USD", linehaulCents: 115_000, detentionCents: 842_500, totalCents: 957_500 });
    expect(await app.prisma.proofOfDelivery.findUnique({ where: { shipmentId: id } })).toMatchObject({
      sha256: createHash("sha256").update(png).digest("hex"),
    });
    expect((await readdir(uploadDir)).length).toBe(files.length + 1);
    expect(shipmentEvent).toHaveBeenCalledExactlyOnceWith(id, "shipment:updated", {
      shipmentId: id, status: "DELIVERED", checkpointId: checkpoint.id, sequence: 5, currentEtaAt: null,
    });
    expect(userEvent.mock.calls).toEqual([shipper.id, carrier.id].map((userId) =>
      [userId, "invoice:updated", { invoiceId: invoice.id, shipmentId: id, status: "ISSUED" }]));
    expect((await request(shipper, path)).json().data).toMatchObject({ load: { id: load.id, status: "COMPLETED" }, invoiceId: invoice.id });
    for (const reader of [shipper, carrier, await account("ADMIN")]) {
      const invoiceDetail = await request(reader, `/invoices/${invoice.id}`);
      expect(invoiceDetail.statusCode, invoiceDetail.body).toBe(200);
      expect(invoiceDetail.json().data).toMatchObject({
        ...invoice, latestPayment: null, detentionCharges: [
          { stop: "PICKUP", freeMinutes: 120, hourlyRateCents: 5_000, billableSeconds: 1_800, amountCents: 2_500 },
          { stop: "DELIVERY", freeMinutes: 120, hourlyRateCents: 5_000, billableSeconds: 604_800, amountCents: 840_000 },
        ],
      });
      const download = await request(reader, podPath);
      expect(download.statusCode, download.body).toBe(200);
      expect(download.headers).toMatchObject({
        "content-type": "image/png", "content-disposition": "attachment", "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      });
      expect(download.rawPayload).toEqual(png);
    }
    expect((await request(outsider, podPath)).statusCode).toBe(404);
    expect((await request(outsider, `/invoices/${invoice.id}`)).statusCode).toBe(404);
    const changed = await pod(carrier, path, key, Buffer.concat([png, Buffer.from("different")]));
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("EVENT_KEY_REUSED");
    const differentKey = await pod(carrier, path, randomUUID());
    expect(differentKey.statusCode).toBe(409);
    expect(differentKey.json().error.code).toBe("POD_ALREADY_EXISTS");
    expect((await request(carrier, track, event("GPS", 160, { clientEventId: key, latitude: 0, longitude: 0 }))).json().error.code)
      .toBe("EVENT_KEY_REUSED");
    expect((await readdir(uploadDir)).length).toBe(files.length + 1);
  } finally {
    issuance.mockRestore();
    shipmentEvent.mockRestore();
    userEvent.mockRestore();
  }
});

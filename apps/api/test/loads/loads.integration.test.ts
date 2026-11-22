import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import type { Role } from "../../src/generated/prisma/client.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const prefix = `loads-${randomUUID()}-`;
const url = "/api/v1/loads";
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp(readConfig({ NODE_ENV: "test", DATABASE_URL: requireTestDatabaseUrl(), JWT_SECRET: randomUUID() }));
  await app.ready();
});

afterAll(async () => {
  if (!app) return;
  try {
    if (app.prisma) {
      const email = { startsWith: prefix };
      await app.prisma.bid.deleteMany({ where: { load: { shipper: { email } } } });
      await app.prisma.load.deleteMany({ where: { shipper: { email } } });
      await app.prisma.carrierProfile.deleteMany({ where: { user: { email } } });
      await app.prisma.user.deleteMany({ where: { email } });
    }
  } finally {
    await app.close();
  }
});

async function account(role: Role, name: string) {
  const user = await app.prisma.user.create({ data: { email: `${prefix}${name}@example.test`, role, displayName: name, passwordHash: "fixture" } });
  const profile = role === "CARRIER" ? await app.prisma.carrierProfile.create({ data: { userId: user.id } }) : undefined;
  return { id: user.id, headers: { authorization: `Bearer ${await app.auth.signAccessToken(user.id)}` }, profileId: profile?.id };
}

it("scopes load access, validates schedules and closes active bids atomically without replay events", async () => {
  const shipper = await account("SHIPPER", "shipper");
  const otherShipper = await account("SHIPPER", "other");
  const admin = await account("ADMIN", "admin");
  const bidder = await account("CARRIER", "bidder");
  const observer = await account("CARRIER", "observer");
  const inactiveBidder = await account("CARRIER", "inactive");
  const createdAt = Date.now();
  const input = {
    description: "  Pallets  ", pickupCity: "  New   York  ", pickupRegion: "ny", pickupLat: 40.7, pickupLng: -74,
    deliveryCity: "Washington", deliveryRegion: " dc ", deliveryLat: 38.9, deliveryLng: -77,
    pickupReadyAt: new Date(createdAt + 3600_000).toISOString(), deliveryBy: new Date(createdAt + 7200_000).toISOString(),
  };
  const emit = vi.spyOn(app, "emitToUser");
  const create = (payload: object, headers = shipper.headers) => app.inject({ method: "POST", url, headers, payload });
  expect((await create(input, bidder.headers)).statusCode).toBe(403);
  expect((await create({ ...input, pickupRegion: "ZZ" })).statusCode).toBe(400);
  expect((await create({ ...input, pickupLat: "40" })).statusCode).toBe(400);
  expect((await create({ ...input, status: "OPEN" })).statusCode).toBe(400);
  expect((await create({ ...input, deliveryBy: input.pickupReadyAt })).json().error.code).toBe("INVALID_LOAD_SCHEDULE");
  const created = await create(input);
  expect(created.statusCode, created.body).toBe(201);
  const load = created.json().data;
  expect(load).toMatchObject({ shipperId: shipper.id, status: "DRAFT", description: "Pallets", pickupCity: "New York", pickupRegion: "NY", deliveryRegion: "DC" });
  const detail = `${url}/${load.id}`;
  const get = (path: string, headers = shipper.headers) => app.inject({ url: path, headers });
  const patch = (payload: object, headers = shipper.headers) => app.inject({ method: "PATCH", url: detail, headers, payload });
  const action = (name: "publish" | "cancel") => app.inject({ method: "POST", url: `${detail}/${name}`, headers: shipper.headers });

  expect((await get(detail, otherShipper.headers)).statusCode).toBe(404);
  expect((await patch({ description: "changed" }, otherShipper.headers)).statusCode).toBe(404);
  expect((await get(detail, admin.headers)).statusCode).toBe(200);
  expect((await get(url, bidder.headers)).json().error.code).toBe("CARRIER_NOT_APPROVED");
  expect((await get(`${url}?unknown=1`)).statusCode).toBe(400);
  expect((await get(`${url}?limit=1`)).json()).toMatchObject({ data: [load], meta: { limit: 1, offset: 0, hasMore: false } });
  expect((await get(url, otherShipper.headers)).json().data).toEqual([]);
  expect((await patch({ deliveryBy: input.pickupReadyAt })).json().error.code).toBe("INVALID_LOAD_SCHEDULE");
  expect((await patch({ description: " Revised pallets " })).json().data.description).toBe("Revised pallets");

  for (const carrier of [bidder, observer, inactiveBidder]) {
    await app.prisma.carrierProfile.update({ where: { id: carrier.profileId }, data: { verificationStatus: "APPROVED" } });
  }
  expect((await get(detail, bidder.headers)).statusCode).toBe(404);
  expect((await action("publish")).json().data.status).toBe("OPEN");
  expect((await action("publish")).json().error.code).toBe("LOAD_NOT_DRAFT");
  expect((await patch({ description: "changed" })).json().error.code).toBe("LOAD_NOT_EDITABLE");
  expect((await get(detail, bidder.headers)).statusCode).toBe(200);
  expect((await get(`${url}?status=DRAFT`, bidder.headers)).json().data).toEqual([]);
  expect((await get(`${url}?status=OPEN`, bidder.headers)).json().data).toContainEqual(expect.objectContaining({ id: load.id }));
  expect(emit).not.toHaveBeenCalled();

  const active = await app.prisma.bid.create({ data: { loadId: load.id, carrierProfileId: bidder.profileId!, currentRevision: 2 } });
  const closed = await app.prisma.bid.create({ data: { loadId: load.id, carrierProfileId: inactiveBidder.profileId!, status: "CLOSED" } });
  const cancellations = await Promise.all([action("cancel"), action("cancel")]);
  for (const response of cancellations) expect(response.json().data.status).toBe("CANCELLED");
  expect(cancellations[0].json().data).toEqual(cancellations[1].json().data);
  expect(await app.prisma.bid.findUnique({ where: { id: active.id } })).toMatchObject({ status: "CLOSED", currentRevision: 2 });
  expect(await app.prisma.bid.findUnique({ where: { id: closed.id } })).toEqual(closed);
  expect(emit.mock.calls).toEqual([shipper.id, bidder.id].map((userId) => [userId, "bid:updated", {
    loadId: load.id, bidId: active.id, status: "CLOSED", currentRevision: 2,
  }]));
  expect((await get(detail, bidder.headers)).statusCode).toBe(200);
  expect((await get(detail, observer.headers)).statusCode).toBe(404);

  const expired = await create({
    ...input, pickupReadyAt: new Date(createdAt - 7200_000).toISOString(), deliveryBy: new Date(createdAt - 3600_000).toISOString(),
  });
  const expiredUrl = `${url}/${expired.json().data.id}`;
  const publishExpired = await app.inject({ method: "POST", url: `${expiredUrl}/publish`, headers: shipper.headers, payload: {} });
  expect(publishExpired.json().error.code).toBe("INVALID_LOAD_SCHEDULE");
  const cancelDraft = await app.inject({ method: "POST", url: `${expiredUrl}/cancel`, headers: shipper.headers });
  expect(cancelDraft.json().data.status).toBe("CANCELLED");
  expect(emit).toHaveBeenCalledTimes(2);
  emit.mockRestore();
});

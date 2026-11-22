import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import type { Role } from "../../src/generated/prisma/client.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const prefix = `loads-access-${randomUUID()}-`;
const loadsUrl = "/api/v1/loads";
let app: ReturnType<typeof buildApp>;
let shipper: Account;
let otherShipper: Account;
let admin: Account;
let carrier: Account;
let openLoadId: string;
let draftLoadId: string;
let cancelLoadId: string;
let assignedLoadId: string;

type Account = {
  id: string;
  headers: { authorization: string };
  profileId?: string;
};

beforeAll(async () => {
  app = buildApp(readConfig({
    NODE_ENV: "test", DATABASE_URL: requireTestDatabaseUrl(), JWT_SECRET: randomUUID(),
  }));
  await app.ready();

  shipper = await account("SHIPPER", "shipper");
  otherShipper = await account("SHIPPER", "other-shipper");
  admin = await account("ADMIN", "admin");
  carrier = await account("CARRIER", "carrier");

  openLoadId = await createLoad("open");
  draftLoadId = await createLoad("draft");
  cancelLoadId = await createLoad("cancel");
  assignedLoadId = await createLoad("assigned");
  await publish(openLoadId);
  await publish(cancelLoadId);
  await app.prisma.load.update({ where: { id: assignedLoadId }, data: { status: "ASSIGNED" } });
});

afterAll(async () => {
  try {
    if (app?.prisma) {
      const email = { startsWith: prefix };
      await app.prisma.bid.deleteMany({ where: { load: { shipper: { email } } } });
      await app.prisma.load.deleteMany({ where: { shipper: { email } } });
      await app.prisma.carrierProfile.deleteMany({ where: { user: { email } } });
      await app.prisma.user.deleteMany({ where: { email } });
    }
  } finally {
    await app?.close();
  }
});

async function account(role: Role, name: string): Promise<Account> {
  const user = await app.prisma.user.create({
    data: { email: `${prefix}${name}@example.test`, displayName: name, role, passwordHash: "fixture" },
  });
  const profile = role === "CARRIER" ? await app.prisma.carrierProfile.create({ data: { userId: user.id } }) : undefined;
  return {
    id: user.id,
    headers: { authorization: `Bearer ${await app.auth.signAccessToken(user.id)}` },
    profileId: profile?.id,
  };
}

function loadInput(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    description: "Access probe",
    pickupCity: "Columbus", pickupRegion: "OH", pickupLat: 39.96, pickupLng: -83.0,
    deliveryCity: "Indianapolis", deliveryRegion: "IN", deliveryLat: 39.77, deliveryLng: -86.16,
    pickupReadyAt: new Date(now + 3_600_000).toISOString(),
    deliveryBy: new Date(now + 7_200_000).toISOString(),
    ...overrides,
  };
}

async function createLoad(name: string, overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST", url: loadsUrl, headers: shipper.headers, payload: loadInput({ description: name, ...overrides }),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().data.id as string;
}

async function publish(id: string) {
  const response = await app.inject({ method: "POST", url: `${loadsUrl}/${id}/publish`, headers: shipper.headers });
  expect(response.statusCode, response.body).toBe(200);
}

async function approveCarrier() {
  await app.prisma.carrierProfile.update({
    where: { id: carrier.profileId! }, data: { verificationStatus: "APPROVED" },
  });
}

it("authenticates before parsing an invalid body", async () => {
  const response = await app.inject({
    method: "POST", url: loadsUrl, headers: { "content-type": "application/json" }, payload: "{",
  });
  expect(response.statusCode).toBe(401);
  expect(response.json().error.code).toBe("UNAUTHENTICATED");
});

it("denies an unapproved carrier on list and read", async () => {
  const list = await app.inject({ url: loadsUrl, headers: carrier.headers });
  expect(list.statusCode).toBe(403);
  expect(list.json().error.code).toBe("CARRIER_NOT_APPROVED");

  const read = await app.inject({ url: `${loadsUrl}/${openLoadId}`, headers: carrier.headers });
  expect(read.statusCode).toBe(404);
  expect(read.json().error.code).toBe("NOT_FOUND");
});

it("grants an approved carrier immediate access to open loads", async () => {
  await approveCarrier();
  const list = await app.inject({ url: loadsUrl, headers: carrier.headers });
  expect(list.statusCode).toBe(200);
  expect(list.json().data).toContainEqual(expect.objectContaining({ id: openLoadId, status: "OPEN" }));

  const read = await app.inject({ url: `${loadsUrl}/${openLoadId}`, headers: carrier.headers });
  expect(read.statusCode).toBe(200);
  expect(read.json().data.id).toBe(openLoadId);
});

it("keeps drafts and other shippers' loads out of a carrier's scope", async () => {
  await approveCarrier();
  const read = await app.inject({ url: `${loadsUrl}/${draftLoadId}`, headers: carrier.headers });
  expect(read.statusCode).toBe(404);

  const list = await app.inject({ url: `${loadsUrl}?status=DRAFT`, headers: carrier.headers });
  expect(list.statusCode).toBe(200);
  expect(list.json().data).toEqual([]);
});

it("hides another shipper's loads from reads and edits", async () => {
  const read = await app.inject({ url: `${loadsUrl}/${openLoadId}`, headers: otherShipper.headers });
  expect(read.statusCode).toBe(404);

  const patch = await app.inject({
    method: "PATCH", url: `${loadsUrl}/${openLoadId}`, headers: otherShipper.headers,
    payload: { description: "hijacked" },
  });
  expect(patch.statusCode).toBe(404);
  expect((await app.prisma.load.findUnique({ where: { id: openLoadId } }))?.description).toBe("open");
});

it("rejects invalid regions, coordinates and schedules", async () => {
  const base = loadInput();
  const region = await app.inject({
    method: "POST", url: loadsUrl, headers: shipper.headers, payload: { ...base, pickupRegion: "ZZ" },
  });
  expect(region.statusCode).toBe(400);

  const latitude = await app.inject({
    method: "POST", url: loadsUrl, headers: shipper.headers, payload: { ...base, pickupLat: 91 },
  });
  expect(latitude.statusCode).toBe(400);

  const longitude = await app.inject({
    method: "POST", url: loadsUrl, headers: shipper.headers, payload: { ...base, deliveryLng: -181 },
  });
  expect(longitude.statusCode).toBe(400);

  const equalSchedule = await app.inject({
    method: "POST", url: loadsUrl, headers: shipper.headers, payload: { ...base, deliveryBy: base.pickupReadyAt },
  });
  expect(equalSchedule.statusCode).toBe(422);
  expect(equalSchedule.json().error.code).toBe("INVALID_LOAD_SCHEDULE");

  const now = Date.now();
  const past = await app.inject({
    method: "POST", url: loadsUrl, headers: shipper.headers,
    payload: loadInput({
      pickupReadyAt: new Date(now - 7_200_000).toISOString(),
      deliveryBy: new Date(now - 3_600_000).toISOString(),
    }),
  });
  expect(past.statusCode).toBe(201);
  const publishPast = await app.inject({
    method: "POST", url: `${loadsUrl}/${past.json().data.id}/publish`, headers: shipper.headers,
  });
  expect(publishPast.statusCode).toBe(422);
  expect(publishPast.json().error.code).toBe("INVALID_LOAD_SCHEDULE");
});

it("replays cancellation and refuses to cancel an assigned load", async () => {
  const first = await app.inject({ method: "POST", url: `${loadsUrl}/${cancelLoadId}/cancel`, headers: shipper.headers });
  expect(first.statusCode).toBe(200);
  expect(first.json().data.status).toBe("CANCELLED");

  const second = await app.inject({ method: "POST", url: `${loadsUrl}/${cancelLoadId}/cancel`, headers: shipper.headers });
  expect(second.statusCode).toBe(200);
  expect(second.json().data).toEqual(first.json().data);

  const assigned = await app.inject({ method: "POST", url: `${loadsUrl}/${assignedLoadId}/cancel`, headers: shipper.headers });
  expect(assigned.statusCode).toBe(409);
  expect(assigned.json().error.code).toBe("LOAD_NOT_CANCELLABLE");
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import type { Role } from "../../src/generated/prisma/client.js";
import * as loads from "../../src/modules/loads/service.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const prefix = `bids-${randomUUID()}-`;
const base = "/api/v1";
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp(readConfig({ NODE_ENV: "test", DATABASE_URL: requireTestDatabaseUrl(), JWT_SECRET: randomUUID() }));
  await app.ready();
});

afterAll(async () => {
  try {
    if (app?.prisma) {
      const email = { startsWith: prefix };
      const load = { shipper: { email } };
      await app.prisma.trackingCheckpoint.deleteMany({ where: { shipment: { load } } });
      await app.prisma.shipment.deleteMany({ where: { load } });
      await app.prisma.bidOffer.deleteMany({ where: { bid: { load } } });
      await app.prisma.bid.deleteMany({ where: { load } });
      await app.prisma.load.deleteMany({ where: load });
      await app.prisma.carrierProfile.deleteMany({ where: { user: { email } } });
      await app.prisma.user.deleteMany({ where: { email } });
    }
  } finally {
    await app?.close();
  }
});

async function account(role: Role, name: string, approved = true) {
  const user = await app.prisma.user.create({
    data: { email: `${prefix}${randomUUID()}@example.test`, role, displayName: name, passwordHash: "fixture" },
  });
  const profile = role === "CARRIER" ? await app.prisma.carrierProfile.create({
    data: { userId: user.id, verificationStatus: approved ? "APPROVED" : "DRAFT" },
  }) : undefined;
  return { id: user.id, profileId: profile?.id, headers: { authorization: `Bearer ${await app.auth.signAccessToken(user.id)}` } };
}

type Account = Awaited<ReturnType<typeof account>>;
function request(user: Account, path: string, method: "GET" | "POST" = "GET", payload?: object) {
  return app.inject({ method, url: base + path, headers: user.headers, payload });
}

async function openLoad(shipper: Account) {
  const load = await app.prisma.load.create({
    data: {
      shipperId: shipper.id, status: "OPEN", description: "Test load", pickupCity: "New York", pickupRegion: "NY",
      pickupLat: 40.7, pickupLng: -74, deliveryCity: "Boston", deliveryRegion: "MA", deliveryLat: 42.4, deliveryLng: -71,
      pickupReadyAt: new Date(Date.now() + 60_000), deliveryBy: new Date(Date.now() + 120_000),
    },
  });
  return load.id;
}

function place(carrier: Account, loadId: string, amountCents = 120_000) {
  return request(carrier, `/loads/${loadId}/bids`, "POST", { amountCents });
}

async function bidFor(carrier: Account, loadId: string) {
  const response = await place(carrier, loadId);
  expect(response.statusCode, response.body).toBe(201);
  return response.json().data.id as string;
}

function counter(user: Account, bidId: string, expectedRevision: number, amountCents = 110_000) {
  return request(user, `/bids/${bidId}/offers`, "POST", { amountCents, expectedRevision });
}

function accept(shipper: Account, bidId: string, expectedRevision = 1) {
  return request(shipper, `/bids/${bidId}/accept`, "POST", { expectedRevision });
}

it("negotiates, assigns atomically, emits private updates, and replays with current records", async () => {
  const shipper = await account("SHIPPER", "Owner");
  const winner = await account("CARRIER", "Winning carrier");
  const loser = await account("CARRIER", "Competing carrier");
  const observer = await account("CARRIER", "Observer");
  const admin = await account("ADMIN", "Admin");
  const loadId = await openLoad(shipper);
  const emit = vi.spyOn(app, "emitToUser");
  try {
    const bidId = await bidFor(winner, loadId);
    const competingId = await bidFor(loser, loadId);
    expect(emit.mock.calls).toEqual([
      ...[shipper.id, winner.id].map((id) => [id, "bid:updated", { loadId, bidId, status: "ACTIVE", currentRevision: 1 }]),
      ...[shipper.id, loser.id].map((id) => [id, "bid:updated", { loadId, bidId: competingId, status: "ACTIVE", currentRevision: 1 }]),
    ]);
    expect((await place(winner, loadId)).json().error.code).toBe("BID_ALREADY_EXISTS");
    expect((await counter(winner, bidId, 1)).json().error.code).toBe("OFFER_OUT_OF_TURN");
    const shipperOffer = await counter(shipper, bidId, 1);
    expect(shipperOffer.statusCode, shipperOffer.body).toBe(200);
    expect(shipperOffer.json().data).toMatchObject({ currentRevision: 2, currentOffer: { authorRole: "SHIPPER", amountCents: 110_000 } });
    expect((await accept(shipper, bidId)).json().error.code).toBe("STALE_OFFER");
    expect((await accept(shipper, bidId, 2)).json().error.code).toBe("CARRIER_OFFER_REQUIRED");
    const carrierOffer = await counter(winner, bidId, 2, 115_000);
    expect(carrierOffer.statusCode, carrierOffer.body).toBe(200);
    expect(carrierOffer.json().data).toMatchObject({
      currentRevision: 3, carrierDisplayName: "Winning carrier",
      currentOffer: { revision: 3, authorRole: "CARRIER", authorUserId: winner.id, amountCents: 115_000 },
      offers: [{ revision: 1, amountCents: 120_000 }, { revision: 2, amountCents: 110_000 }, { revision: 3, amountCents: 115_000 }],
    });
    for (const participant of [shipper, winner, admin]) {
      expect((await request(participant, `/bids/${bidId}`)).json()).toEqual(carrierOffer.json());
    }
    expect(emit.mock.calls.slice(4)).toEqual([2, 3].flatMap((currentRevision) =>
      [shipper.id, winner.id].map((id) => [id, "bid:updated", { loadId, bidId, status: "ACTIVE", currentRevision }]),
    ));
    emit.mockClear();

    const response = await accept(shipper, bidId, 3);
    expect(response.statusCode, response.body).toBe(200);
    const assigned = response.json().data;
    expect(assigned).toMatchObject({
      load: { id: loadId, status: "ASSIGNED" },
      bid: { id: bidId, status: "ACCEPTED", currentRevision: 3 },
      shipment: { loadId, status: "ASSIGNED", acceptedBidId: bidId, acceptedRevision: 3, acceptedRateCents: 115_000, carrierProfileId: winner.profileId },
    });
    expect(assigned.bid).not.toHaveProperty("offers");
    expect(await app.prisma.trackingCheckpoint.findMany({ where: { shipmentId: assigned.shipment.id } })).toMatchObject([{
      sequence: 1, kind: "ASSIGNED", occurredAt: new Date(assigned.shipment.assignedAt), actorUserId: null, clientEventId: null,
    }]);
    expect(emit.mock.calls).toEqual([
      ...[shipper.id, winner.id].map((id) => [id, "bid:updated", { loadId, bidId, status: "ACCEPTED", currentRevision: 3 }]),
      ...[shipper.id, loser.id].map((id) => [id, "bid:updated", { loadId, bidId: competingId, status: "CLOSED", currentRevision: 1 }]),
      ...[shipper.id, winner.id].map((id) => [id, "load:assigned", { loadId, shipmentId: assigned.shipment.id, bidId, status: "ASSIGNED" }]),
    ]);
    expect((await request(loser, `/bids?loadId=${loadId}&status=CLOSED`)).json().data).toMatchObject([{ id: competingId }]);
    expect((await request(winner, `/bids?loadId=${loadId}&status=CLOSED`)).json().data).toEqual([]);
    expect((await request(winner, `/bids?loadId=${loadId}&status=ACCEPTED`)).json().data).toEqual([assigned.bid]);
    expect((await request(admin, `/loads/${loadId}/bids?status=ACCEPTED&limit=1`)).json()).toEqual({
      data: [assigned.bid], meta: { limit: 1, offset: 0, hasMore: false },
    });
    for (const participant of [shipper, winner, admin]) {
      expect((await request(participant, "/shipments?status=ASSIGNED")).json().data).toContainEqual(assigned.shipment);
    }
    for (const carrier of [loser, observer]) {
      expect((await request(carrier, "/shipments")).json().data).toEqual([]);
    }

    const pickedUpAt = new Date();
    await app.prisma.shipment.update({ where: { id: assigned.shipment.id }, data: { status: "IN_TRANSIT", pickedUpAt } });
    const replay = await accept(shipper, bidId, 3);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data).toEqual({
      ...assigned, shipment: { ...assigned.shipment, status: "IN_TRANSIT", pickedUpAt: pickedUpAt.toISOString() },
    });
    expect((await accept(shipper, bidId, 2)).statusCode).toBe(409);
    expect((await accept(shipper, competingId)).statusCode).toBe(409);
    expect(emit).toHaveBeenCalledTimes(6);
    expect(await app.prisma.shipment.count({ where: { loadId } })).toBe(1);
    expect(await app.prisma.trackingCheckpoint.count({ where: { shipmentId: assigned.shipment.id } })).toBe(1);
  } finally {
    emit.mockRestore();
  }
});

it("enforces participant scopes, current approval, and strict request validation", async () => {
  const shipper = await account("SHIPPER", "Owner");
  const outsider = await account("SHIPPER", "Outsider");
  const admin = await account("ADMIN", "Admin");
  const bidder = await account("CARRIER", "Bidder");
  const otherCarrier = await account("CARRIER", "Other carrier");
  const unapproved = await account("CARRIER", "Unapproved", false);
  const loadId = await openLoad(shipper);
  const bidsPath = `/loads/${loadId}/bids`;
  const bidId = await bidFor(bidder, loadId);
  const bidPath = `/bids/${bidId}`;

  expect((await app.inject({ url: base + bidPath })).statusCode).toBe(401);
  expect((await request(outsider, bidsPath)).statusCode).toBe(404);
  expect((await request(otherCarrier, bidsPath)).statusCode).toBe(403);
  expect((await request(shipper, "/bids")).statusCode).toBe(403);
  expect((await request(otherCarrier, `/bids?loadId=${loadId}`)).json().data).toEqual([]);
  expect((await request(otherCarrier, bidPath)).statusCode).toBe(404);
  expect((await counter(otherCarrier, bidId, 1)).statusCode).toBe(404);
  expect((await accept(outsider, bidId)).statusCode).toBe(404);
  expect((await accept(bidder, bidId)).statusCode).toBe(403);
  expect((await counter(admin, bidId, 1)).statusCode).toBe(403);
  expect((await place(unapproved, loadId)).json().error.code).toBe("CARRIER_NOT_APPROVED");
  expect((await place(unapproved, loadId)).statusCode).toBe(403);

  for (const payload of [{ amountCents: 49 }, { amountCents: 90_000_001 }, { amountCents: 50.5 },
    { amountCents: "50" }, { amountCents: 50, status: "ACCEPTED" }, {}]) {
    expect((await request(otherCarrier, bidsPath, "POST", payload)).statusCode).toBe(400);
  }
  expect((await request(bidder, "/bids?status=UNSUPPORTED")).statusCode).toBe(400);
  expect((await request(bidder, "/bids?loadId=invalid")).statusCode).toBe(400);
  expect((await request(shipper, `${bidsPath}?loadId=${loadId}`)).statusCode).toBe(400);
  expect((await request(shipper, `${bidPath}/accept`, "POST", { expectedRevision: "1" })).statusCode).toBe(400);
  expect((await counter(shipper, bidId, 0)).statusCode).toBe(400);

  await app.prisma.carrierProfile.update({ where: { id: bidder.profileId }, data: { verificationStatus: "REJECTED" } });
  const rejectedCounter = await counter(shipper, bidId, 1);
  expect(rejectedCounter.statusCode).toBe(403);
  expect(rejectedCounter.json().error.code).toBe("CARRIER_NOT_APPROVED");
  const rejectedAccept = await accept(shipper, bidId);
  expect(rejectedAccept.statusCode).toBe(409);
  expect(rejectedAccept.json().error.code).toBe("CARRIER_NOT_APPROVED");
  expect((await request(bidder, bidPath)).json().data).toMatchObject({ currentRevision: 1, status: "ACTIVE" });
});

type Response = Awaited<ReturnType<typeof request>>;
async function raceAfterOpenRead(start: () => Promise<Response>, compete: () => Promise<Response>): Promise<[Response, Response]> {
  const opened = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = loads.readLoadForBids;
  let firstRead = true;
  const read = vi.spyOn(loads, "readLoadForBids").mockImplementation(async (tx, id) => {
    // Let the first request establish its real PostgreSQL snapshot before the second commits.
    const load = await original(tx, id);
    if (firstRead) {
      firstRead = false;
      expect(load.status).toBe("OPEN");
      opened.resolve();
      await release.promise;
    }
    return load;
  });
  const first = start();
  try {
    await Promise.race([opened.promise, first.then((response) => { throw new Error(response.body); })]);
    const second = await compete();
    release.resolve();
    return [await first, second];
  } finally {
    release.resolve();
    await first;
    read.mockRestore();
  }
}

async function expectRaceResult(
  [lost, won]: [Response, Response],
  loadId: string,
  status: "CANCELLED" | "OPEN" | "ASSIGNED",
  expectedCode: "LOAD_NOT_OPEN" | "STALE_OFFER",
) {
  expect(won.statusCode, won.body).toBe(200);
  expect(lost.statusCode, lost.body).toBe(409);
  expect(lost.json().error.code).toBe(expectedCode);
  const load = await app.prisma.load.findUniqueOrThrow({ where: { id: loadId }, include: { bids: true, shipment: true } });
  expect(load.status).toBe(status);
  const active = load.bids.filter((bid) => bid.status === "ACTIVE");
  const accepted = load.bids.filter((bid) => bid.status === "ACCEPTED");
  if (status !== "OPEN") expect(active).toHaveLength(0);
  expect(accepted).toHaveLength(status === "ASSIGNED" ? 1 : 0);
  expect(load.shipment?.acceptedBidId).toBe(accepted[0]?.id);
  return load;
}

it("cancels a load while a bid create is in flight", async () => {
  const shipper = await account("SHIPPER", "Owner");
  const carrier = await account("CARRIER", "Carrier");
  const loadId = await openLoad(shipper);
  const result = await raceAfterOpenRead(
    () => place(carrier, loadId), () => request(shipper, `/loads/${loadId}/cancel`, "POST"),
  );
  expect((await expectRaceResult(result, loadId, "CANCELLED", "LOAD_NOT_OPEN")).bids).toEqual([]);
});

it("cancels a load while an acceptance is in flight", async () => {
  const shipper = await account("SHIPPER", "Owner");
  const carrier = await account("CARRIER", "Carrier");
  const loadId = await openLoad(shipper);
  const bidId = await bidFor(carrier, loadId);
  const result = await raceAfterOpenRead(
    () => accept(shipper, bidId), () => request(shipper, `/loads/${loadId}/cancel`, "POST"),
  );
  const load = await expectRaceResult(result, loadId, "CANCELLED", "LOAD_NOT_OPEN");
  expect(load.bids).toMatchObject([{ id: bidId, status: "CLOSED" }]);
});

it("gives a load to only one of two concurrent acceptances", async () => {
  const shipper = await account("SHIPPER", "Owner");
  const firstCarrier = await account("CARRIER", "First carrier");
  const secondCarrier = await account("CARRIER", "Second carrier");
  const loadId = await openLoad(shipper);
  const firstBid = await bidFor(firstCarrier, loadId);
  const secondBid = await bidFor(secondCarrier, loadId);
  const result = await raceAfterOpenRead(() => accept(shipper, firstBid), () => accept(shipper, secondBid));
  const load = await expectRaceResult(result, loadId, "ASSIGNED", "LOAD_NOT_OPEN");
  expect(load.bids).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: firstBid, status: "CLOSED" }),
    expect.objectContaining({ id: secondBid, status: "ACCEPTED" }),
  ]));
});

it("rejects acceptance of a revision superseded by a concurrent counter", async () => {
  const shipper = await account("SHIPPER", "Owner");
  const carrier = await account("CARRIER", "Carrier");
  const loadId = await openLoad(shipper);
  const bidId = await bidFor(carrier, loadId);
  const result = await raceAfterOpenRead(() => accept(shipper, bidId), () => counter(shipper, bidId, 1));
  const load = await expectRaceResult(result, loadId, "OPEN", "STALE_OFFER");
  expect(load.bids).toMatchObject([{ id: bidId, status: "ACTIVE", currentRevision: 2 }]);
});

it("rejects a new bid when acceptance assigns the load during creation", async () => {
  const shipper = await account("SHIPPER", "Owner");
  const carrier = await account("CARRIER", "Winning carrier");
  const newcomer = await account("CARRIER", "New carrier");
  const loadId = await openLoad(shipper);
  const bidId = await bidFor(carrier, loadId);
  const result = await raceAfterOpenRead(() => place(newcomer, loadId), () => accept(shipper, bidId));
  const load = await expectRaceResult(result, loadId, "ASSIGNED", "LOAD_NOT_OPEN");
  expect(load.bids).toMatchObject([{ id: bidId, status: "ACCEPTED" }]);
});

it("rejects a counter when cancellation closes the bid", async () => {
  const shipper = await account("SHIPPER", "Owner");
  const carrier = await account("CARRIER", "Carrier");
  const loadId = await openLoad(shipper);
  const bidId = await bidFor(carrier, loadId);
  const result = await raceAfterOpenRead(
    () => counter(shipper, bidId, 1), () => request(shipper, `/loads/${loadId}/cancel`, "POST"),
  );
  const load = await expectRaceResult(result, loadId, "CANCELLED", "LOAD_NOT_OPEN");
  expect(load.bids).toMatchObject([{ id: bidId, status: "CLOSED", currentRevision: 1 }]);
});

it("assigns eight different loads through parallel acceptance requests", async () => {
  const fixtures: { shipper: Account; loadId: string; bidId: string }[] = [];
  for (let index = 0; index < 8; index++) {
    const shipper = await account("SHIPPER", `Burst shipper ${index + 1}`);
    const carrier = await account("CARRIER", `Burst carrier ${index + 1}`);
    const loadId = await openLoad(shipper);
    fixtures.push({ shipper, loadId, bidId: await bidFor(carrier, loadId) });
  }

  const results = await Promise.all(fixtures.map(({ shipper, bidId }) => accept(shipper, bidId)));
  for (const [index, response] of results.entries()) {
    const { loadId, bidId } = fixtures[index];
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      load: { id: loadId, status: "ASSIGNED" },
      bid: { id: bidId, status: "ACCEPTED" },
      shipment: { loadId, acceptedBidId: bidId, status: "ASSIGNED" },
    });
  }
  expect(await app.prisma.bid.count({
    where: { loadId: { in: fixtures.map(({ loadId }) => loadId) }, status: "ACTIVE" },
  })).toBe(0);
});

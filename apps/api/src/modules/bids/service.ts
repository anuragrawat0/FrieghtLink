import type { FastifyInstance } from "fastify";
import { Prisma, type BidStatus, type Load } from "../../generated/prisma/client.js";
import type { AuthenticatedUser } from "../../plugins/auth.js";
import { AppError } from "../../shared/errors.js";
import { withSerializableTransaction } from "../../shared/transactions.js";
import { isCarrierApproved, readApprovedCarrierId } from "../carriers/service.js";
import { assignLoad, readLoadForBids, toLoadDto } from "../loads/service.js";
import { createAssignment, readAssignment, toShipmentDto } from "../shipments/service.js";

export type BidQuery = { limit?: number; offset?: number; status?: BidStatus; loadId?: string };
export type OfferInput = { amountCents: number; expectedRevision: number };

const carrier = { select: { user: { select: { id: true, displayName: true } } } } as const;
const author = { select: { role: true } } as const;
const bidDetails = {
  carrierProfile: carrier,
  offers: { include: { author }, orderBy: { revision: "asc" } },
} as const;
type BidRow = Prisma.BidGetPayload<{ include: { carrierProfile: typeof carrier } }>;
type OfferRow = Prisma.BidOfferGetPayload<{ include: { author: typeof author } }>;

function toOfferDto({ revision, authorUserId, amountCents, createdAt, author }: OfferRow) {
  return { revision, authorUserId, amountCents, createdAt: createdAt.toISOString(), authorRole: author.role };
}

function currentOffer(bid: BidRow, offers: OfferRow[]) {
  const offer = offers.find(({ revision }) => revision === bid.currentRevision);
  if (!offer) throw new Error("The bid's current offer is missing.");
  return offer;
}

function toBidDto(bid: BidRow, offer: OfferRow) {
  return {
    id: bid.id, loadId: bid.loadId, carrierProfileId: bid.carrierProfileId, status: bid.status,
    currentRevision: bid.currentRevision, carrierDisplayName: bid.carrierProfile.user.displayName,
    createdAt: bid.createdAt.toISOString(), updatedAt: bid.updatedAt.toISOString(), currentOffer: toOfferDto(offer),
  };
}

function toBidDetailDto(bid: BidRow & { offers: OfferRow[] }) {
  return {
    ...toBidDto(bid, currentOffer(bid, bid.offers)),
    offers: bid.offers.filter(({ revision }) => revision <= bid.currentRevision).map(toOfferDto),
  };
}

function forbidden() {
  return new AppError(403, "FORBIDDEN", "This action is unavailable to your role.");
}

function notFound() {
  return new AppError(404, "NOT_FOUND", "The bid was not found.");
}

function requireOpen(load: Load) {
  if (load.status !== "OPEN") throw new AppError(409, "LOAD_NOT_OPEN", "This load is no longer open.");
}

function requireCurrentBid(bid: BidRow, expectedRevision: number) {
  if (bid.status !== "ACTIVE") throw new AppError(409, "BID_NOT_ACTIVE", "This bid is no longer active.");
  if (bid.currentRevision !== expectedRevision) throw new AppError(409, "STALE_OFFER", "The bid has a newer offer.");
}

function requireApproval(approved: boolean, status: 403 | 409) {
  if (!approved) throw new AppError(status, "CARRIER_NOT_APPROVED", "Carrier verification is required.");
}

async function findBid(db: Prisma.TransactionClient, id: string) {
  const bid = await db.bid.findUnique({ where: { id }, include: bidDetails });
  if (!bid) throw notFound();
  return bid;
}

function requireParticipant(user: AuthenticatedUser, load: Load, bid: BidRow) {
  if ((user.role === "SHIPPER" && load.shipperId === user.id)
    || (user.role === "CARRIER" && bid.carrierProfile.user.id === user.id)) return;
  throw notFound();
}

function emitBidUpdate(
  app: FastifyInstance, load: Load, carrierUserId: string,
  bid: { id: string; currentRevision: number; status: BidStatus },
) {
  const payload = { loadId: load.id, bidId: bid.id, status: bid.status, currentRevision: bid.currentRevision };
  app.emitToUser(load.shipperId, "bid:updated", payload);
  app.emitToUser(carrierUserId, "bid:updated", payload);
}

async function listBids(db: Prisma.TransactionClient, where: Prisma.BidWhereInput, { limit = 20, offset = 0 }: BidQuery) {
  const rows = await db.bid.findMany({
    where, include: { carrierProfile: carrier },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: offset, take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const offers = page.length ? await db.bidOffer.findMany({
    where: { OR: page.map(({ id, currentRevision }) => ({ bidId: id, revision: currentRevision })) },
    include: { author },
  }) : [];
  const offersByBid = new Map(offers.map((offer) => [offer.bidId, offer]));
  return {
    data: page.map((bid) => {
      const offer = offersByBid.get(bid.id);
      if (!offer) throw new Error("The bid's current offer is missing.");
      return toBidDto(bid, offer);
    }),
    meta: { limit, offset, hasMore: rows.length > limit },
  };
}

export async function listLoadBids(db: Prisma.TransactionClient, user: AuthenticatedUser, loadId: string, query: BidQuery) {
  if (user.role !== "SHIPPER" && user.role !== "ADMIN") throw forbidden();
  const load = await readLoadForBids(db, loadId);
  if (user.role === "SHIPPER" && load.shipperId !== user.id) throw notFound();
  return listBids(db, { loadId, status: query.status }, query);
}

export async function listOwnBids(db: Prisma.TransactionClient, user: AuthenticatedUser, query: BidQuery) {
  if (user.role !== "CARRIER") throw forbidden();
  return listBids(db, { carrierProfile: { userId: user.id }, loadId: query.loadId, status: query.status }, query);
}

export async function readBid(db: Prisma.TransactionClient, user: AuthenticatedUser, id: string) {
  const bid = await findBid(db, id);
  if (user.role !== "ADMIN") requireParticipant(user, await readLoadForBids(db, bid.loadId), bid);
  return toBidDetailDto(bid);
}

export async function createBid(app: FastifyInstance, user: AuthenticatedUser, loadId: string, amountCents: number) {
  if (user.role !== "CARRIER") throw forbidden();
  const { bid, load } = await withSerializableTransaction(app.prisma, async (tx) => {
    const carrierProfileId = await readApprovedCarrierId(tx, user.id);
    if (!carrierProfileId) throw new AppError(403, "CARRIER_NOT_APPROVED", "Carrier verification is required.");
    const load = await readLoadForBids(tx, loadId);
    requireOpen(load);
    try {
      const bid = await tx.bid.create({
        data: {
          loadId, carrierProfileId,
          offers: { create: { revision: 1, authorUserId: user.id, amountCents } },
        },
        include: bidDetails,
      });
      return { bid, load };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "BID_ALREADY_EXISTS", "You already have a bid on this load.");
      }
      throw error;
    }
  });
  emitBidUpdate(app, load, user.id, bid);
  return toBidDetailDto(bid);
}

export async function counterBid(app: FastifyInstance, user: AuthenticatedUser, id: string, input: OfferInput) {
  if (user.role !== "SHIPPER" && user.role !== "CARRIER") throw forbidden();
  const { bid, load } = await withSerializableTransaction(app.prisma, async (tx) => {
    const bid = await findBid(tx, id);
    const load = await readLoadForBids(tx, bid.loadId);
    requireParticipant(user, load, bid);
    requireOpen(load);
    requireCurrentBid(bid, input.expectedRevision);
    requireApproval(await isCarrierApproved(tx, bid.carrierProfile.user.id), 403);
    if (currentOffer(bid, bid.offers).authorUserId === user.id) {
      throw new AppError(409, "OFFER_OUT_OF_TURN", "Wait for the other participant to make an offer.");
    }
    const revision = bid.currentRevision + 1;
    const updated = await tx.bid.update({
      where: { id }, data: {
        currentRevision: revision,
        offers: { create: { revision, authorUserId: user.id, amountCents: input.amountCents } },
      },
      include: bidDetails,
    });
    return { bid: updated, load };
  });
  emitBidUpdate(app, load, bid.carrierProfile.user.id, bid);
  return toBidDetailDto(bid);
}

export async function acceptBid(app: FastifyInstance, user: AuthenticatedUser, id: string, expectedRevision: number) {
  if (user.role !== "SHIPPER") throw forbidden();
  const result = await withSerializableTransaction(app.prisma, async (tx) => {
    // Prefer the bid and load indexes to avoid relation-wide predicate locks on small tables.
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    const bid = await findBid(tx, id);
    const load = await readLoadForBids(tx, bid.loadId);
    requireParticipant(user, load, bid);
    if (bid.status === "ACCEPTED" && bid.currentRevision === expectedRevision) {
      const shipment = await readAssignment(tx, id, expectedRevision);
      if (shipment) return { bid, load, shipment };
    }

    requireOpen(load);
    requireCurrentBid(bid, expectedRevision);
    const offer = currentOffer(bid, bid.offers);
    if (offer.authorUserId !== bid.carrierProfile.user.id) {
      throw new AppError(409, "CARRIER_OFFER_REQUIRED", "Only a carrier offer can be accepted.");
    }
    requireApproval(await isCarrierApproved(tx, bid.carrierProfile.user.id), 409);

    const assignedLoad = await assignLoad(tx, load.id);
    const acceptedBid = await tx.bid.update({ where: { id }, data: { status: "ACCEPTED" } });
    const closed = await readClosedBidNotifications(tx, await closeActiveBidsForLoad(tx, load.id));
    const shipment = await createAssignment(tx, {
      loadId: load.id, acceptedBidId: id, acceptedRevision: expectedRevision, carrierProfileId: bid.carrierProfileId,
      acceptedRateCents: offer.amountCents,
    });
    return { bid: { ...bid, ...acceptedBid }, load: assignedLoad, shipment, closed };
  });
  const { bid, load, shipment, closed } = result;
  if (closed) {
    emitBidUpdate(app, load, bid.carrierProfile.user.id, bid);
    for (const entry of closed) {
      emitBidUpdate(app, load, entry.carrierProfile.userId, { ...entry, status: "CLOSED" });
    }
    const payload = { loadId: load.id, shipmentId: shipment.id, bidId: bid.id, status: "ASSIGNED" } as const;
    app.emitToUser(load.shipperId, "load:assigned", payload);
    app.emitToUser(bid.carrierProfile.user.id, "load:assigned", payload);
  }
  return { load: toLoadDto(load), bid: toBidDto(bid, currentOffer(bid, bid.offers)), shipment: toShipmentDto(shipment) };
}

export async function closeActiveBidsForLoad(tx: Prisma.TransactionClient, loadId: string) {
  const closed = await tx.bid.updateManyAndReturn({
    where: { loadId, status: "ACTIVE" }, data: { status: "CLOSED" }, select: { id: true },
  });
  return closed.map(({ id }) => id);
}

export async function carrierHasBidForLoad(db: Prisma.TransactionClient, loadId: string, carrierUserId: string) {
  const bid = await db.bid.findFirst({ where: { loadId, carrierProfile: { userId: carrierUserId } }, select: { id: true } });
  return bid !== null;
}

export function readClosedBidNotifications(tx: Prisma.TransactionClient, ids: string[]) {
  return tx.bid.findMany({
    where: { id: { in: ids } },
    select: { id: true, currentRevision: true, carrierProfile: { select: { userId: true } } },
  });
}

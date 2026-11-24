import type { FastifyInstance } from "fastify";
import type { Load, LoadStatus, Prisma } from "../../generated/prisma/client.js";
import type { AuthenticatedUser } from "../../plugins/auth.js";
import { AppError } from "../../shared/errors.js";
import { withSerializableTransaction } from "../../shared/transactions.js";
import { carrierHasBidForLoad, closeActiveBidsForLoad, readClosedBidNotifications } from "../bids/service.js";
import { isCarrierApproved } from "../carriers/service.js";

export type LoadInput = Pick<Load, "description" | "pickupCity" | "pickupRegion" | "pickupLat" | "pickupLng" |
  "deliveryCity" | "deliveryRegion" | "deliveryLat" | "deliveryLng"> & { pickupReadyAt: string; deliveryBy: string };
export type LoadQuery = { limit?: number; offset?: number; status?: LoadStatus };

export function toLoadDto(load: Load) {
  const { id, shipperId, status, description, pickupCity, pickupRegion, pickupLat, pickupLng,
    deliveryCity, deliveryRegion, deliveryLat, deliveryLng, pickupReadyAt, deliveryBy, isSample, createdAt, updatedAt } = load;
  return { id, shipperId, status, description, pickupCity, pickupRegion, pickupLat, pickupLng,
    deliveryCity, deliveryRegion, deliveryLat, deliveryLng, isSample,
    pickupReadyAt: pickupReadyAt.toISOString(), deliveryBy: deliveryBy.toISOString(),
    createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() };
}

export async function readLoadForBids(db: Prisma.TransactionClient, id: string) {
  const load = await db.load.findUnique({ where: { id } });
  if (!load) throw notFound();
  return load;
}
export { readLoadForBids as readLoadRecord };

export function assignLoad(tx: Prisma.TransactionClient, id: string) {
  return tx.load.update({ where: { id }, data: { status: "ASSIGNED" } });
}

export function completeLoad(tx: Prisma.TransactionClient, id: string) {
  return tx.load.update({ where: { id, status: "ASSIGNED" }, data: { status: "COMPLETED" } });
}

function requireShipper(user: AuthenticatedUser) {
  if (user.role !== "SHIPPER") throw new AppError(403, "FORBIDDEN", "This action is only available to shippers.");
}

function notFound() {
  return new AppError(404, "NOT_FOUND", "The load was not found.");
}

function requireSchedule(pickupReadyAt: Date, deliveryBy: Date, publishing = false) {
  if (pickupReadyAt >= deliveryBy || (publishing && deliveryBy.getTime() <= Date.now())) {
    throw new AppError(422, "INVALID_LOAD_SCHEDULE", "The load schedule is invalid.");
  }
}

async function ownLoad(db: Prisma.TransactionClient, user: AuthenticatedUser, id: string) {
  requireShipper(user);
  const load = await db.load.findUnique({ where: { id, shipperId: user.id } });
  if (!load) throw notFound();
  return load;
}

export async function createLoad(db: Prisma.TransactionClient, user: AuthenticatedUser, input: LoadInput) {
  requireShipper(user);
  const pickupReadyAt = new Date(input.pickupReadyAt);
  const deliveryBy = new Date(input.deliveryBy);
  requireSchedule(pickupReadyAt, deliveryBy);
  const load = await db.load.create({ data: { ...input, pickupReadyAt, deliveryBy, shipperId: user.id } });
  return toLoadDto(load);
}

export async function listLoads(db: Prisma.TransactionClient, user: AuthenticatedUser, query: LoadQuery) {
  const { limit = 20, offset = 0, status } = query;
  const where: Prisma.LoadWhereInput = { status };
  if (user.role === "SHIPPER") where.shipperId = user.id;
  if (user.role === "CARRIER") {
    if (!await isCarrierApproved(db, user.id)) {
      throw new AppError(403, "CARRIER_NOT_APPROVED", "Carrier verification is required to browse loads.");
    }
    if (status && status !== "OPEN") return { data: [], meta: { limit, offset, hasMore: false } };
    where.status = "OPEN";
  }
  const rows = await db.load.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: offset, take: limit + 1 });
  return { data: rows.slice(0, limit).map(toLoadDto), meta: { limit, offset, hasMore: rows.length > limit } };
}

export async function readLoad(db: Prisma.TransactionClient, user: AuthenticatedUser, id: string) {
  const load = await readLoadForBids(db, id);
  if (user.role === "ADMIN" || (user.role === "SHIPPER" && load.shipperId === user.id)) return toLoadDto(load);
  if (user.role === "CARRIER") {
    if ((load.status === "OPEN" && await isCarrierApproved(db, user.id)) || await carrierHasBidForLoad(db, load.id, user.id)) {
      return toLoadDto(load);
    }
  }
  throw notFound();
}

export async function updateLoad(app: FastifyInstance, user: AuthenticatedUser, id: string, input: Partial<LoadInput>) {
  const updated = await withSerializableTransaction(app.prisma, async (tx) => {
    const load = await ownLoad(tx, user, id);
    if (load.status !== "DRAFT") throw new AppError(409, "LOAD_NOT_EDITABLE", "Only draft loads can be edited.");
    const pickupReadyAt = input.pickupReadyAt ? new Date(input.pickupReadyAt) : load.pickupReadyAt;
    const deliveryBy = input.deliveryBy ? new Date(input.deliveryBy) : load.deliveryBy;
    requireSchedule(pickupReadyAt, deliveryBy);
    return tx.load.update({ where: { id }, data: { ...input, pickupReadyAt, deliveryBy } });
  });
  return toLoadDto(updated);
}

export async function publishLoad(app: FastifyInstance, user: AuthenticatedUser, id: string) {
  const published = await withSerializableTransaction(app.prisma, async (tx) => {
    const load = await ownLoad(tx, user, id);
    if (load.status !== "DRAFT") throw new AppError(409, "LOAD_NOT_DRAFT", "Only draft loads can be published.");
    requireSchedule(load.pickupReadyAt, load.deliveryBy, true);
    return tx.load.update({ where: { id }, data: { status: "OPEN" } });
  });
  return toLoadDto(published);
}

export async function cancelLoad(app: FastifyInstance, user: AuthenticatedUser, id: string) {
  const { load, bids } = await withSerializableTransaction(app.prisma, async (tx) => {
    const load = await ownLoad(tx, user, id);
    if (load.status === "CANCELLED") return { load, bids: [] };
    if (load.status !== "DRAFT" && load.status !== "OPEN") {
      throw new AppError(409, "LOAD_NOT_CANCELLABLE", "Only draft and open loads can be cancelled.");
    }
    const cancelled = await tx.load.update({ where: { id }, data: { status: "CANCELLED" } });
    const closedIds = await closeActiveBidsForLoad(tx, load.id);
    const bids = closedIds.length ? await readClosedBidNotifications(tx, closedIds) : [];
    return { load: cancelled, bids };
  });
  for (const bid of bids) {
    const payload = { loadId: load.id, bidId: bid.id, status: "CLOSED", currentRevision: bid.currentRevision } as const;
    app.emitToUser(load.shipperId, "bid:updated", payload);
    app.emitToUser(bid.carrierProfile.userId, "bid:updated", payload);
  }
  return toLoadDto(load);
}

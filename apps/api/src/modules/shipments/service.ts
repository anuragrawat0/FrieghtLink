import type { Prisma, PrismaClient, Shipment, ShipmentStatus } from "../../generated/prisma/client.js";
import type { AuthenticatedUser } from "../../plugins/auth.js";
import { AppError } from "../../shared/errors.js";
import { withSerializableTransaction } from "../../shared/transactions.js";
import { readInvoiceId } from "../billing/service.js";
import { readLoadRecord, toLoadDto } from "../loads/service.js";
import { shipmentReadScope } from "./access.js";
import { toProofDto } from "./dto.js";

export type Pagination = { limit?: number; offset?: number };
export type ShipmentQuery = Pagination & { status?: ShipmentStatus; loadId?: string };
type Assignment = Pick<Shipment, "loadId" | "acceptedBidId" | "acceptedRevision" | "carrierProfileId" | "acceptedRateCents">;

export function toShipmentDto(shipment: Shipment) {
  const { id, loadId, acceptedBidId, acceptedRevision, carrierProfileId, acceptedRateCents, status,
    assignedAt, pickedUpAt, deliveryArrivedAt, deliveredAt, currentEtaAt } = shipment;
  return {
    id, loadId, acceptedBidId, acceptedRevision, carrierProfileId, acceptedRateCents, status,
    assignedAt: assignedAt.toISOString(),
    pickedUpAt: pickedUpAt?.toISOString() ?? null,
    deliveryArrivedAt: deliveryArrivedAt?.toISOString() ?? null,
    deliveredAt: deliveredAt?.toISOString() ?? null,
    currentEtaAt: currentEtaAt?.toISOString() ?? null,
  };
}

export function readAssignment(tx: Prisma.TransactionClient, acceptedBidId: string, acceptedRevision: number) {
  return tx.shipment.findUnique({ where: { acceptedBidId, acceptedRevision } });
}

export async function createAssignment(tx: Prisma.TransactionClient, input: Assignment) {
  const shipment = await tx.shipment.create({ data: { ...input, status: "ASSIGNED" } });
  await tx.trackingCheckpoint.create({
    data: { shipmentId: shipment.id, sequence: 1, kind: "ASSIGNED", occurredAt: shipment.assignedAt },
  });
  return shipment;
}

export async function listShipments(db: Prisma.TransactionClient, user: AuthenticatedUser, query: ShipmentQuery) {
  const { limit = 20, offset = 0, status, loadId } = query;
  const rows = await db.shipment.findMany({
    where: { status, loadId, ...shipmentReadScope(user) },
    orderBy: [{ assignedAt: "desc" }, { id: "desc" }],
    skip: offset, take: limit + 1,
  });
  return { data: rows.slice(0, limit).map(toShipmentDto), meta: { limit, offset, hasMore: rows.length > limit } };
}

export function shipmentNotFound() {
  return new AppError(404, "NOT_FOUND", "The shipment was not found.");
}

export async function readShipment(db: Prisma.TransactionClient, user: AuthenticatedUser, id: string) {
  const shipment = await db.shipment.findUnique({ where: { id, AND: shipmentReadScope(user) } });
  if (!shipment) throw shipmentNotFound();
  return shipment;
}

export async function readAssignedShipment(db: Prisma.TransactionClient, user: AuthenticatedUser, id: string) {
  if (user.role !== "CARRIER") throw new AppError(403, "FORBIDDEN", "Only the assigned carrier may record tracking updates.");
  return readShipment(db, user, id);
}

export function readShipmentDetail(db: PrismaClient, user: AuthenticatedUser, id: string) {
  return withSerializableTransaction(db, async (tx) => {
    const shipment = await readShipment(tx, user, id);
    const load = await readLoadRecord(tx, shipment.loadId);
    const proof = shipment.status === "DELIVERED" ? await tx.proofOfDelivery.findUnique({ where: { shipmentId: id } }) : null;
    const invoiceId = shipment.status === "DELIVERED" ? await readInvoiceId(tx, id) : null;
    return { ...toShipmentDto(shipment), load: toLoadDto(load), proofOfDelivery: proof ? toProofDto(proof) : null, invoiceId };
  });
}

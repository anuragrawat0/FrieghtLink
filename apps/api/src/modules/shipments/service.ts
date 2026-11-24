import type { Prisma, Shipment, ShipmentStatus } from "../../generated/prisma/client.js";
import type { AuthenticatedUser } from "../../plugins/auth.js";
import { shipmentReadScope } from "./access.js";

export type ShipmentQuery = { limit?: number; offset?: number; status?: ShipmentStatus };
type Assignment = Pick<Shipment, "loadId" | "acceptedBidId" | "acceptedRevision" | "carrierProfileId" | "acceptedRateCents">;

export function toShipmentDto(shipment: Shipment) {
  const { assignedAt, pickedUpAt, deliveryArrivedAt, deliveredAt, currentEtaAt, ...fields } = shipment;
  return {
    ...fields,
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
  const { limit = 20, offset = 0, status } = query;
  const rows = await db.shipment.findMany({
    where: { status, ...shipmentReadScope(user) },
    orderBy: [{ assignedAt: "desc" }, { id: "desc" }],
    skip: offset, take: limit + 1,
  });
  return { data: rows.slice(0, limit).map(toShipmentDto), meta: { limit, offset, hasMore: rows.length > limit } };
}

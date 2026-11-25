import type { FastifyInstance } from "fastify";
import type { AuthenticatedUser } from "../../plugins/auth.js";
import { AppError, errorContext } from "../../shared/errors.js";
import { withSerializableTransaction } from "../../shared/transactions.js";
import { issueInvoice, readShipmentInvoice, toInvoiceDto } from "../billing/service.js";
import { completeLoad } from "../loads/service.js";
import { toCheckpointDto, toProofDto } from "./dto.js";
import { readAssignedShipment, readShipment, shipmentNotFound, toShipmentDto } from "./service.js";
import { emitShipmentUpdated, eventKeyReused, findEvent, invalidTransition, lastCheckpoint } from "./tracking.js";

type SavedFile = Awaited<ReturnType<FastifyInstance["uploads"]["save"]>>;

export async function completeShipment(app: FastifyInstance, user: AuthenticatedUser, shipmentId: string,
  clientEventId: string, saved: SavedFile) {
  const result = await withSerializableTransaction(app.prisma, async (tx) => {
    const shipment = await readAssignedShipment(tx, user, shipmentId);
    const prior = await findEvent(tx, shipmentId, clientEventId);
    if (prior) {
      if (prior.kind !== "DELIVERED") throw eventKeyReused();
      const proof = await tx.proofOfDelivery.findUniqueOrThrow({ where: { shipmentId } });
      if (proof.sha256 !== saved.sha256 || proof.mimeType !== saved.mimeType) throw eventKeyReused();
      const invoice = await readShipmentInvoice(tx, shipmentId);
      return { shipment, checkpoint: prior, proof, invoice, shipperId: null };
    }
    if (shipment.status === "DELIVERED") {
      throw new AppError(409, "POD_ALREADY_EXISTS", "This shipment already has proof of delivery.");
    }

    const last = await lastCheckpoint(tx, shipmentId);
    const { pickedUpAt, deliveryArrivedAt } = shipment;
    if (shipment.status !== "IN_TRANSIT" || last.kind !== "DELIVERY_ARRIVAL" || !pickedUpAt || !deliveryArrivedAt) {
      throw invalidTransition();
    }
    const pickupArrival = await tx.trackingCheckpoint.findFirstOrThrow({
      where: { shipmentId, kind: "PICKUP_ARRIVAL" }, select: { occurredAt: true },
    });
    const deliveredAt = new Date();
    if (deliveredAt < last.occurredAt) throw invalidTransition();

    // Advance the shipment first so concurrent POD and checkpoint writes retry on the same row.
    const updated = await tx.shipment.update({
      where: { id: shipmentId }, data: { status: "DELIVERED", deliveredAt, currentEtaAt: null },
    });
    const proof = await tx.proofOfDelivery.create({ data: { shipmentId, ...saved, uploadedAt: deliveredAt } });
    const checkpoint = await tx.trackingCheckpoint.create({
      data: { shipmentId, sequence: last.sequence + 1, kind: "DELIVERED",
        actorUserId: user.id, clientEventId, occurredAt: deliveredAt, recordedAt: deliveredAt },
    });
    const load = await completeLoad(tx, shipment.loadId);
    const invoice = await issueInvoice(tx, {
      shipmentId, linehaulCents: shipment.acceptedRateCents, pickupArrival: pickupArrival.occurredAt,
      pickupDeparture: pickedUpAt, deliveryArrival: deliveryArrivedAt, deliveryDeparture: deliveredAt,
    });
    return { shipment: updated, checkpoint, proof, invoice, shipperId: load.shipperId };
  });

  const { shipment, checkpoint, proof, invoice, shipperId } = result;
  if (shipperId) {
    emitShipmentUpdated(app, shipment, checkpoint);
    const payload = { invoiceId: invoice.id, shipmentId: shipment.id, status: invoice.status };
    app.emitToUser(shipperId, "invoice:updated", payload);
    app.emitToUser(user.id, "invoice:updated", payload);
  }
  return { replay: shipperId === null, data: {
    shipment: toShipmentDto(shipment), checkpoint: toCheckpointDto(checkpoint),
    proofOfDelivery: toProofDto(proof), invoice: toInvoiceDto(invoice),
  } };
}

export async function removeUnreferencedPod(app: FastifyInstance, storageKey: string) {
  try {
    const reference = await app.prisma.proofOfDelivery.findUnique({ where: { storageKey }, select: { id: true } });
    if (!reference) await app.uploads.remove(storageKey);
  } catch (error) {
    app.log.warn({ failure: errorContext(error) }, "POD file cleanup failed");
  }
}

export async function openPod(app: FastifyInstance, user: AuthenticatedUser, shipmentId: string) {
  await readShipment(app.prisma, user, shipmentId);
  const proof = await app.prisma.proofOfDelivery.findUnique({ where: { shipmentId } });
  if (!proof) throw shipmentNotFound();
  return { mimeType: proof.mimeType, stream: await app.uploads.open(proof.storageKey) };
}

import type { FastifyInstance } from "fastify";
import type { CheckpointKind, Prisma, Shipment, TrackingCheckpoint } from "../../generated/prisma/client.js";
import type { AuthenticatedUser } from "../../plugins/auth.js";
import { AppError } from "../../shared/errors.js";
import { withSerializableTransaction } from "../../shared/transactions.js";
import { readLoadRecord } from "../loads/service.js";
import { toCheckpointDto } from "./dto.js";
import { readAssignedShipment, readShipment, toShipmentDto, type Pagination } from "./service.js";

export type CheckpointInput = {
  clientEventId: string;
  kind: Exclude<CheckpointKind, "ASSIGNED" | "DELIVERED">;
  occurredAt: string;
  latitude?: number;
  longitude?: number;
};

const allowedNext: Partial<Record<CheckpointKind, CheckpointInput["kind"][]>> = {
  ASSIGNED: ["PICKUP_ARRIVAL"],
  PICKUP_ARRIVAL: ["PICKED_UP"],
  PICKED_UP: ["GPS", "DELIVERY_ARRIVAL"],
  GPS: ["GPS", "DELIVERY_ARRIVAL"],
};

export function travelEta(occurredAt: Date, fromLat: number, fromLng: number, toLat: number, toLng: number) {
  const radians = Math.PI / 180;
  const a = Math.sin((toLat - fromLat) * radians / 2) ** 2
    + Math.cos(fromLat * radians) * Math.cos(toLat * radians) * Math.sin((toLng - fromLng) * radians / 2) ** 2;
  const kilometers = 2 * 6_371 * Math.asin(Math.sqrt(Math.min(1, a)));
  return new Date(occurredAt.getTime() + Math.ceil(kilometers * 60 / 65) * 60_000);
}

export function invalidTransition() {
  return new AppError(409, "INVALID_SHIPMENT_TRANSITION", "This checkpoint is out of order.");
}

export function eventKeyReused() {
  return new AppError(409, "EVENT_KEY_REUSED", "This client event ID was used for a different payload.");
}

export function findEvent(db: Prisma.TransactionClient, shipmentId: string, clientEventId: string) {
  return db.trackingCheckpoint.findUnique({ where: { shipmentId_clientEventId: { shipmentId, clientEventId } } });
}

export function lastCheckpoint(db: Prisma.TransactionClient, shipmentId: string) {
  return db.trackingCheckpoint.findFirstOrThrow({ where: { shipmentId }, orderBy: { sequence: "desc" } });
}

export function emitShipmentUpdated(app: FastifyInstance, shipment: Shipment, checkpoint: TrackingCheckpoint) {
  app.emitToShipment(shipment.id, "shipment:updated", {
    shipmentId: shipment.id, status: shipment.status, checkpointId: checkpoint.id, sequence: checkpoint.sequence,
    currentEtaAt: shipment.currentEtaAt?.toISOString() ?? null,
  });
}

export async function listCheckpoints(db: Prisma.TransactionClient, user: AuthenticatedUser, shipmentId: string, query: Pagination) {
  await readShipment(db, user, shipmentId);
  const { limit = 20, offset = 0 } = query;
  const rows = await db.trackingCheckpoint.findMany({
    where: { shipmentId }, orderBy: { sequence: "asc" }, skip: offset, take: limit + 1,
  });
  return { data: rows.slice(0, limit).map(toCheckpointDto), meta: { limit, offset, hasMore: rows.length > limit } };
}

export async function addCheckpoint(app: FastifyInstance, user: AuthenticatedUser, shipmentId: string, input: CheckpointInput) {
  const { clientEventId, kind, occurredAt: time, latitude = null, longitude = null } = input;
  const occurredAt = new Date(time);
  const serverTime = new Date();
  const result = await withSerializableTransaction(app.prisma, async (tx) => {
    const shipment = await readAssignedShipment(tx, user, shipmentId);
    const prior = await findEvent(tx, shipmentId, clientEventId);
    if (prior) {
      if (prior.kind !== kind || prior.occurredAt.getTime() !== occurredAt.getTime()
          || prior.latitude !== latitude || prior.longitude !== longitude) throw eventKeyReused();
      return { shipment, checkpoint: prior, replay: true };
    }

    const last = await lastCheckpoint(tx, shipmentId);
    if (!allowedNext[last.kind]?.includes(kind)) throw invalidTransition();
    if (occurredAt < last.occurredAt || occurredAt > serverTime) {
      throw new AppError(422, "INVALID_CHECKPOINT_TIME", "Use a time between the last checkpoint and server time.");
    }

    const update: Prisma.ShipmentUpdateInput = { currentEtaAt: null };
    if (kind === "PICKED_UP" || kind === "GPS") {
      const load = await readLoadRecord(tx, shipment.loadId);
      update.currentEtaAt = travelEta(occurredAt, latitude ?? load.pickupLat, longitude ?? load.pickupLng,
        load.deliveryLat, load.deliveryLng);
      if (kind === "PICKED_UP") {
        update.status = "IN_TRANSIT";
        update.pickedUpAt = occurredAt;
      }
    } else if (kind === "DELIVERY_ARRIVAL") {
      update.deliveryArrivedAt = occurredAt;
      update.currentEtaAt = occurredAt;
    }

    // Competing appends contend on the shipment row before inserting a sequence or client key.
    const updated = await tx.shipment.update({ where: { id: shipmentId }, data: update });
    const checkpoint = await tx.trackingCheckpoint.create({
      data: { shipmentId, sequence: last.sequence + 1, kind, actorUserId: user.id, clientEventId, occurredAt, latitude, longitude },
    });
    return { shipment: updated, checkpoint, replay: false };
  });
  if (!result.replay) emitShipmentUpdated(app, result.shipment, result.checkpoint);
  return { replay: result.replay, data: { shipment: toShipmentDto(result.shipment), checkpoint: toCheckpointDto(result.checkpoint) } };
}

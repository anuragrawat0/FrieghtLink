import { CheckpointKind, ShipmentStatus } from "../../generated/prisma/enums.js";
import { limit, objectSchema, offset, pageMeta, timestamp, uuid } from "../../shared/http-schemas.js";
import { invoice } from "../billing/schemas.js";
import { load } from "../loads/schemas.js";

const status = { type: "string", enum: Object.values(ShipmentStatus) } as const;
const nullableTime = { anyOf: [timestamp, { type: "null" }] } as const;

export const shipment = objectSchema({
  id: uuid, loadId: uuid, acceptedBidId: uuid, acceptedRevision: { type: "integer", minimum: 1 },
  carrierProfileId: uuid, acceptedRateCents: { type: "integer", minimum: 50, maximum: 90_000_000 },
  status, assignedAt: timestamp, pickedUpAt: nullableTime, deliveryArrivedAt: nullableTime,
  deliveredAt: nullableTime, currentEtaAt: nullableTime,
});

export const shipmentParams = objectSchema({ shipmentId: uuid });
export const shipmentQuery = objectSchema({ limit, offset, status, loadId: uuid }, []);
export const shipmentListResponse = objectSchema({ data: { type: "array", items: shipment }, meta: pageMeta });
export const checkpointQuery = objectSchema({ limit, offset }, []);

const latitude = { type: "number", minimum: -90, maximum: 90 } as const;
const longitude = { type: "number", minimum: -180, maximum: 180 } as const;
const nullable = <T>(field: T) => ({ anyOf: [field, { type: "null" }] } as const);
const checkpoint = objectSchema({
  id: uuid, shipmentId: uuid, sequence: { type: "integer", minimum: 1 },
  kind: { type: "string", enum: Object.values(CheckpointKind) },
  actorUserId: nullable(uuid), clientEventId: nullable(uuid), occurredAt: timestamp, recordedAt: timestamp,
  latitude: nullable(latitude), longitude: nullable(longitude),
});
const proofOfDelivery = objectSchema({
  id: uuid, shipmentId: uuid, mimeType: { type: "string", enum: ["image/jpeg", "image/png"] },
  sizeBytes: { type: "integer" }, uploadedAt: timestamp,
});

export const shipmentDetailResponse = objectSchema({
  data: objectSchema({ ...shipment.properties, load, proofOfDelivery: nullable(proofOfDelivery), invoiceId: nullable(uuid) }),
});
export const checkpointListResponse = objectSchema({ data: { type: "array", items: checkpoint }, meta: pageMeta });
export const checkpointInput = {
  ...objectSchema({
    clientEventId: uuid, occurredAt: timestamp, latitude, longitude,
    kind: { type: "string", enum: ["PICKUP_ARRIVAL", "PICKED_UP", "GPS", "DELIVERY_ARRIVAL"] },
  }, ["clientEventId", "kind", "occurredAt"]),
  if: { properties: { kind: { const: "GPS" } }, required: ["kind"] },
  then: { required: ["latitude", "longitude"] },
  else: { properties: { latitude: false, longitude: false } },
};
export const checkpointResponse = objectSchema({ data: objectSchema({ shipment, checkpoint }) });
export const podResponse = objectSchema({ data: objectSchema({ shipment, checkpoint, proofOfDelivery, invoice }) });

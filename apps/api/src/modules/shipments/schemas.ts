import { ShipmentStatus } from "../../generated/prisma/enums.js";
import { limit, objectSchema, offset, pageMeta, timestamp, uuid } from "../../shared/http-schemas.js";

const status = { type: "string", enum: Object.values(ShipmentStatus) } as const;
const nullableTime = { anyOf: [timestamp, { type: "null" }] } as const;

export const shipment = objectSchema({
  id: uuid, loadId: uuid, acceptedBidId: uuid, acceptedRevision: { type: "integer", minimum: 1 },
  carrierProfileId: uuid, acceptedRateCents: { type: "integer", minimum: 50, maximum: 90_000_000 },
  status, assignedAt: timestamp, pickedUpAt: nullableTime, deliveryArrivedAt: nullableTime,
  deliveredAt: nullableTime, currentEtaAt: nullableTime,
});

export const shipmentQuery = objectSchema({ limit, offset, status }, []);
export const shipmentListResponse = objectSchema({ data: { type: "array", items: shipment }, meta: pageMeta });

import { BidStatus } from "../../generated/prisma/enums.js";
import { limit, objectSchema, offset, pageMeta, timestamp, uuid } from "../../shared/http-schemas.js";
import { load } from "../loads/schemas.js";
import { shipment } from "../shipments/schemas.js";

const status = { type: "string", enum: Object.values(BidStatus) } as const;
const revision = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
export const amountCents = { type: "integer", minimum: 50, maximum: 90_000_000 } as const;
const offer = objectSchema({
  revision, authorUserId: uuid, amountCents, createdAt: timestamp, authorRole: { type: "string", enum: ["SHIPPER", "CARRIER"] },
});
const bid = objectSchema({
  id: uuid, loadId: uuid, carrierProfileId: uuid, status, currentRevision: revision, createdAt: timestamp, updatedAt: timestamp,
  currentOffer: offer, carrierDisplayName: { type: "string" },
});
const detail = objectSchema({ ...bid.properties, offers: { type: "array", items: offer } });

export const bidParams = objectSchema({ bidId: uuid });
export const loadBidsQuery = objectSchema({ limit, offset, status }, []);
export const ownBidsQuery = objectSchema({ limit, offset, status, loadId: uuid }, []);
export const bidListResponse = objectSchema({ data: { type: "array", items: bid }, meta: pageMeta });
export const bidDetailResponse = objectSchema({ data: detail });
export const acceptResponse = objectSchema({ data: objectSchema({ load, bid, shipment }) });
export const createInput = objectSchema({ amountCents });
export const offerInput = objectSchema({ amountCents, expectedRevision: revision });
export const acceptInput = objectSchema({ expectedRevision: revision });

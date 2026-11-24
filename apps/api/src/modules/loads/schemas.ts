import { LoadStatus } from "../../generated/prisma/enums.js";
import { errorResponseSchema } from "../../shared/errors.js";
import { limit, objectSchema, offset, pageMeta, timestamp, uuid } from "../../shared/http-schemas.js";
export { emptyObject } from "../../shared/http-schemas.js";

const status = { type: "string", enum: Object.values(LoadStatus) } as const;
const city = { type: "string", minLength: 1, maxLength: 100 } as const;
const region = {
  type: "string",
  enum: "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "),
} as const;
const latitude = { type: "number", minimum: -90, maximum: 90 } as const;
const longitude = { type: "number", minimum: -180, maximum: 180 } as const;

export const loadFields = {
  description: { type: "string", minLength: 1, maxLength: 1000 },
  pickupCity: city, pickupRegion: region, pickupLat: latitude, pickupLng: longitude,
  deliveryCity: city, deliveryRegion: region, deliveryLat: latitude, deliveryLng: longitude,
  pickupReadyAt: timestamp, deliveryBy: timestamp,
} as const;

export const loadParams = objectSchema({ loadId: uuid });
export const loadQuery = objectSchema({ limit, offset, status }, []);
export const loadInput = objectSchema(loadFields);
export const loadPatch = { ...objectSchema(loadFields, []), minProperties: 1 };

export const load = objectSchema({
  id: uuid, shipperId: uuid, status, ...loadFields, isSample: { type: "boolean" }, createdAt: timestamp, updatedAt: timestamp,
});
export const loadResponse = objectSchema({ data: load });
export const listResponse = objectSchema({
  data: { type: "array", items: load }, meta: pageMeta,
});
export const errorResponses = { "4xx": errorResponseSchema, "5xx": errorResponseSchema };

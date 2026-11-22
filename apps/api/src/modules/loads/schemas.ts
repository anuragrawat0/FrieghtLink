import { LoadStatus } from "../../generated/prisma/enums.js";
import { errorResponseSchema } from "../../shared/errors.js";

function objectSchema<T extends Record<string, unknown>>(properties: T, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false } as const;
}

const uuid = { type: "string", format: "uuid", minLength: 36, maxLength: 36 } as const;
const timestamp = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" } as const;
const status = { type: "string", enum: Object.values(LoadStatus) } as const;
const limit = { type: "integer", minimum: 1, maximum: 100 } as const;
const offset = { type: "integer", minimum: 0 } as const;
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

export const emptyObject = objectSchema({});
export const loadParams = objectSchema({ loadId: uuid });
export const loadQuery = objectSchema({ limit, offset, status }, []);
export const loadInput = objectSchema(loadFields);
export const loadPatch = { ...objectSchema(loadFields, []), minProperties: 1 };

const load = objectSchema({
  id: uuid, shipperId: uuid, status, ...loadFields, isSample: { type: "boolean" }, createdAt: timestamp, updatedAt: timestamp,
});
export const loadResponse = objectSchema({ data: load });
export const listResponse = objectSchema({
  data: { type: "array", items: load }, meta: objectSchema({ limit, offset, hasMore: { type: "boolean" } }),
});
export const errorResponses = { "4xx": errorResponseSchema, "5xx": errorResponseSchema };

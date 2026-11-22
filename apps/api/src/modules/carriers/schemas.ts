import { VerificationStatus, SafetyRating } from "../../generated/prisma/enums.js";
import { errorResponseSchema } from "../../shared/errors.js";
import { userSchema } from "../users/schemas.js";

function objectSchema<T extends Record<string, unknown>>(properties: T, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false } as const;
}

const uuid = { type: "string", format: "uuid", minLength: 36, maxLength: 36 } as const;
const timestamp = { type: "string", format: "date-time" } as const;
const integer = { type: "integer" } as const;
const text = { type: "string" } as const;
const status = { type: "string", enum: Object.values(VerificationStatus) } as const;
const safetyRating = { type: "string", enum: Object.values(SafetyRating) } as const;
const limit = { ...integer, minimum: 1, maximum: 100 };
const offset = { ...integer, minimum: 0 };

export const emptyObject = objectSchema({});
export const profileIdParams = objectSchema({ carrierProfileId: uuid });
export const queueQuery = objectSchema({ limit, offset, status }, []);
export const profileInput = { ...objectSchema({
  motorCarrierLicense: { ...text, minLength: 1, maxLength: 40 }, safetyRating,
}, []), minProperties: 1 };

export const reviewInput = {
  ...objectSchema({
    decision: { ...text, enum: ["APPROVED", "REJECTED"] },
    expectedRevision: { ...integer, minimum: 1 },
    reviewNote: { ...text, maxLength: 500 },
  }, ["decision", "expectedRevision"]),
  if: { properties: { decision: { const: "REJECTED" } } },
  then: { required: ["reviewNote"], properties: { reviewNote: { type: "string", minLength: 1 } } },
} as const;

export const insurance = objectSchema({ id: uuid, mimeType: text, sizeBytes: integer, uploadedAt: timestamp });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
export const profile = objectSchema({
  id: uuid, userId: uuid, motorCarrierLicense: nullable(text), safetyRating: nullable(safetyRating),
  verificationStatus: status, verificationRevision: integer, verificationSubmittedAt: nullable(timestamp),
  reviewedByUserId: nullable(uuid), reviewedAt: nullable(timestamp), reviewNote: nullable(text), insurance: nullable(insurance),
});

export const adminCarrier = objectSchema({ carrierProfile: profile, user: userSchema });
export const adminQueue = objectSchema({
  data: { type: "array", items: adminCarrier },
  meta: objectSchema({ limit, offset, hasMore: { type: "boolean" } }),
});

export const errorResponses = { "4xx": errorResponseSchema, "5xx": errorResponseSchema };
export const dataResponse = (data: object) => ({ 200: objectSchema({ data }), ...errorResponses });

export const userSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "email", "displayName", "role", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string" },
    displayName: { type: "string" },
    role: { type: "string", enum: ["SHIPPER", "CARRIER", "ADMIN"] },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

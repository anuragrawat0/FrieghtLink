export function objectSchema<T extends Record<string, unknown>>(properties: T, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false } as const;
}

export const emptyObject = objectSchema({});
export const uuid = { type: "string", format: "uuid", minLength: 36, maxLength: 36 } as const;
export const timestamp = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" } as const;
export const limit = { type: "integer", minimum: 1, maximum: 100 } as const;
export const offset = { type: "integer", minimum: 0 } as const;
export const pageMeta = objectSchema({ limit, offset, hasMore: { type: "boolean" } });

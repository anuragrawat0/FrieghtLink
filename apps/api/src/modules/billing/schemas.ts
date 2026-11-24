import { InvoiceStatus, PaymentStatus, StopType } from "../../generated/prisma/enums.js";
import { objectSchema, timestamp, uuid } from "../../shared/http-schemas.js";

const cents = { type: "integer", minimum: 0 } as const;
const nullableTime = { anyOf: [timestamp, { type: "null" }] } as const;
const currency = { type: "string", const: "USD" } as const;

export const invoice = objectSchema({
  id: uuid, shipmentId: uuid, status: { type: "string", enum: Object.values(InvoiceStatus) },
  currency, linehaulCents: cents, detentionCents: cents, totalCents: cents, issuedAt: timestamp, paidAt: nullableTime,
});
const detentionCharge = objectSchema({
  stop: { type: "string", enum: Object.values(StopType) }, arrivedAt: timestamp, departedAt: timestamp,
  freeMinutes: { type: "integer" }, hourlyRateCents: cents, billableSeconds: { type: "integer" }, amountCents: cents,
});
const payment = objectSchema({
  id: uuid, invoiceId: uuid, status: { type: "string", enum: Object.values(PaymentStatus) }, amountCents: cents, currency,
  createdAt: timestamp, checkoutExpiresAt: timestamp, resolvedAt: nullableTime,
});
export const invoiceParams = objectSchema({ invoiceId: uuid });
export const invoiceDetailResponse = objectSchema({ data: objectSchema({
  ...invoice.properties, detentionCharges: { type: "array", items: detentionCharge },
  latestPayment: { anyOf: [payment, { type: "null" }] },
}) });

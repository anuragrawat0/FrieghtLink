import type { DetentionCharge, Invoice, Payment, Prisma, StopType } from "../../generated/prisma/client.js";
import type { AuthenticatedUser } from "../../plugins/auth.js";
import { AppError } from "../../shared/errors.js";
import { canReadShipment } from "../shipments/access.js";

export function detentionSnapshot(stop: StopType, arrivedAt: Date, departedAt: Date) {
  if (departedAt < arrivedAt) throw new Error("Detention departure precedes arrival.");
  const freeMinutes = 120;
  const hourlyRateCents = 5_000;
  const elapsedSeconds = (BigInt(departedAt.getTime()) - BigInt(arrivedAt.getTime())) / 1_000n;
  const overage = elapsedSeconds - BigInt(freeMinutes) * 60n;
  const billableSeconds = overage < 0n ? 0n : overage > 604_800n ? 604_800n : overage;
  const amountCents = Number((billableSeconds * BigInt(hourlyRateCents) + 3_599n) / 3_600n);
  return { stop, arrivedAt, departedAt, freeMinutes, hourlyRateCents, billableSeconds: Number(billableSeconds), amountCents };
}

export async function issueInvoice(tx: Prisma.TransactionClient, input: {
  shipmentId: string; linehaulCents: number;
  pickupArrival: Date; pickupDeparture: Date; deliveryArrival: Date; deliveryDeparture: Date;
}) {
  const { shipmentId, linehaulCents, pickupArrival, pickupDeparture, deliveryArrival, deliveryDeparture } = input;
  const pickup = detentionSnapshot("PICKUP", pickupArrival, pickupDeparture);
  const delivery = detentionSnapshot("DELIVERY", deliveryArrival, deliveryDeparture);
  const detentionCents = pickup.amountCents + delivery.amountCents;
  return tx.invoice.create({
    data: { shipmentId, status: "ISSUED", currency: "USD", linehaulCents, detentionCents,
      totalCents: linehaulCents + detentionCents, issuedAt: deliveryDeparture, detention: { create: [pickup, delivery] } },
  });
}

export function toInvoiceDto(invoice: Invoice) {
  const { id, shipmentId, status, currency, linehaulCents, detentionCents, totalCents, issuedAt, paidAt } = invoice;
  return { id, shipmentId, status, currency, linehaulCents, detentionCents, totalCents,
    issuedAt: issuedAt.toISOString(), paidAt: paidAt?.toISOString() ?? null };
}

function toDetentionDto(charge: DetentionCharge) {
  const { stop, arrivedAt, departedAt, freeMinutes, hourlyRateCents, billableSeconds, amountCents } = charge;
  return { stop, arrivedAt: arrivedAt.toISOString(), departedAt: departedAt.toISOString(), freeMinutes,
    hourlyRateCents, billableSeconds, amountCents };
}

function toPaymentDto(payment: Payment) {
  const { id, invoiceId, status, amountCents, currency, createdAt, checkoutExpiresAt, resolvedAt } = payment;
  return { id, invoiceId, status, amountCents, currency, createdAt: createdAt.toISOString(),
    checkoutExpiresAt: checkoutExpiresAt.toISOString(), resolvedAt: resolvedAt?.toISOString() ?? null };
}

export async function readInvoiceId(db: Prisma.TransactionClient, shipmentId: string) {
  const invoice = await db.invoice.findUnique({ where: { shipmentId }, select: { id: true } });
  return invoice?.id ?? null;
}

export function readShipmentInvoice(db: Prisma.TransactionClient, shipmentId: string) {
  return db.invoice.findUniqueOrThrow({ where: { shipmentId } });
}

export async function readInvoiceDetail(db: Prisma.TransactionClient, user: AuthenticatedUser, id: string) {
  const invoice = await db.invoice.findUnique({ where: { id } });
  if (!invoice || !await canReadShipment(db, user, invoice.shipmentId)) {
    throw new AppError(404, "NOT_FOUND", "The invoice was not found.");
  }
  const [detention, payment] = await Promise.all([
    db.detentionCharge.findMany({ where: { invoiceId: id }, orderBy: { stop: "asc" } }),
    user.role === "CARRIER" ? null : db.payment.findFirst({
      where: { invoiceId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  return { ...toInvoiceDto(invoice), detentionCharges: detention.map(toDetentionDto),
    latestPayment: payment ? toPaymentDto(payment) : null };
}

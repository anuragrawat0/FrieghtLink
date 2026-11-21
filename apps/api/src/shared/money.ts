const maxSafeCents = BigInt(Number.MAX_SAFE_INTEGER);
const detentionFreeMinutes = 120;
const detentionHourlyRateCents = 5000;
const maxBillableSeconds = 604800n;

export function isAmountCents(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value >= min && value <= max;
}

function assertCents(value: number) {
  if (!isAmountCents(value)) throw new RangeError("Amounts must be nonnegative safe integer cents.");
}

function toSafeCents(value: bigint) {
  if (value > maxSafeCents) throw new RangeError("Amount exceeds the safe integer range.");
  return Number(value);
}

export function addCents(...amounts: number[]) {
  let total = 0n;
  for (const amount of amounts) {
    assertCents(amount);
    total += BigInt(amount);
  }
  return toSafeCents(total);
}

export function compareCents(left: number, right: number): -1 | 0 | 1 {
  assertCents(left);
  assertCents(right);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function roundUpCents(numerator: bigint, denominator: bigint) {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("Expected a nonnegative amount and positive divisor.");
  return toSafeCents((numerator + denominator - 1n) / denominator);
}

export function calculateDetentionCharge(arrivedAt: Date, departedAt: Date) {
  const arrival = arrivedAt.getTime();
  const departure = departedAt.getTime();
  if (!Number.isSafeInteger(arrival) || !Number.isSafeInteger(departure) || departure < arrival) {
    throw new RangeError("Detention requires a valid, ordered arrival and departure.");
  }

  const elapsedSeconds = (BigInt(departure) - BigInt(arrival)) / 1000n;
  const chargeableSeconds = elapsedSeconds - BigInt(detentionFreeMinutes) * 60n;
  const billableSeconds = chargeableSeconds <= 0n ? 0n : chargeableSeconds > maxBillableSeconds ? maxBillableSeconds : chargeableSeconds;
  return {
    freeMinutes: detentionFreeMinutes,
    hourlyRateCents: detentionHourlyRateCents,
    billableSeconds: Number(billableSeconds),
    amountCents: roundUpCents(billableSeconds * BigInt(detentionHourlyRateCents), 3600n),
  };
}

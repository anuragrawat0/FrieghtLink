import { expect, it } from "vitest";
import { detentionSnapshot } from "../../src/modules/billing/service.js";

const arrival = new Date("2026-01-01T00:00:00.000Z");

it.each([
  [150 * 60_000, 1_800, 2_500],
  [90 * 60_000, 0, 0],
  [8 * 24 * 60 * 60_000, 604_800, 840_000],
  [120 * 60_000 + 1_999, 1, 2],
])("prices detention for a dwell of %d milliseconds", (dwellMs, billableSeconds, amountCents) => {
  const departure = new Date(arrival.getTime() + dwellMs);
  expect(detentionSnapshot("PICKUP", arrival, departure)).toEqual({
    stop: "PICKUP", arrivedAt: arrival, departedAt: departure, freeMinutes: 120, hourlyRateCents: 5_000,
    billableSeconds, amountCents,
  });
});

it("rejects reversed detention timestamps", () => {
  expect(() => detentionSnapshot("DELIVERY", arrival, new Date(arrival.getTime() - 1))).toThrow();
});

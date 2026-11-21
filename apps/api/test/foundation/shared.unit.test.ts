import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client.js";
import { addCents, calculateDetentionCharge, compareCents, isAmountCents, roundUpCents } from "../../src/shared/money.js";
import { captureRawBody } from "../../src/shared/raw-body.js";
import { withSerializableTransaction } from "../../src/shared/transactions.js";
import { createUploadStorage, uploadLimits } from "../../src/shared/uploads.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

describe("integer money", () => {
  it("validates, compares and adds cents without accepting fractions or overflow", () => {
    expect(isAmountCents(49, 50, 90000000)).toBe(false);
    expect(isAmountCents(50, 50, 90000000)).toBe(true);
    expect(isAmountCents("50")).toBe(false);
    expect(isAmountCents(1.5)).toBe(false);
    expect(isAmountCents(-5)).toBe(false);
    expect(addCents(115000, 2500)).toBe(117500);
    expect(() => addCents(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
    expect(compareCents(100, 99)).toBe(1);
    expect(() => compareCents(100, 99.8)).toThrow(RangeError);
    expect(roundUpCents(5000n, 3600n)).toBe(2);
  });

  it("floors elapsed seconds, rounds the charge up and caps billable time", () => {
    const arrival = new Date("2026-12-01T10:00:00.000Z");
    const departure = (milliseconds: number) => new Date(arrival.getTime() + milliseconds);
    expect(calculateDetentionCharge(arrival, departure(7_200_999)).amountCents).toBe(0);
    expect(calculateDetentionCharge(arrival, departure(7_201_999))).toMatchObject({ billableSeconds: 1, amountCents: 2 });
    expect(calculateDetentionCharge(arrival, departure(9_000_000))).toMatchObject({ billableSeconds: 1800, amountCents: 2500 });
    expect(calculateDetentionCharge(arrival, departure(700_000_000))).toMatchObject({ billableSeconds: 604800, amountCents: 840000 });
    expect(() => calculateDetentionCharge(arrival, departure(-1))).toThrow(RangeError);
  });
});

describe("Serializable retries", () => {
  const conflict = new Prisma.PrismaClientKnownRequestError("Test conflict", { code: "P2034", clientVersion: "7" });

  it("runs the callback again with fresh transaction state", async () => {
    const transaction = vi.fn(async (operation: (tx: { revision: number }) => Promise<number>, _options: { isolationLevel: string }) => operation({ revision: 2 }));
    transaction.mockImplementationOnce((operation) => operation({ revision: 1 }));
    const prisma = { $transaction: transaction } as unknown as PrismaClient;
    const revisions: number[] = [];
    const result = await withSerializableTransaction(prisma, async (tx) => {
      const { revision } = tx as unknown as { revision: number };
      revisions.push(revision);
      if (revision === 1) throw conflict;
      return revision;
    });
    expect(result).toBe(2);
    expect(revisions).toEqual([1, 2]);
    expect(transaction.mock.calls.every((call) => call[1]?.isolationLevel === "Serializable")).toBe(true);
  });

  it("stops after two retries and gives ordinary application errors one attempt", async () => {
    const transaction = vi.fn().mockRejectedValue(conflict);
    const prisma = { $transaction: transaction } as unknown as PrismaClient;
    await expect(withSerializableTransaction(prisma, async () => null)).rejects.toBe(conflict);
    expect(transaction).toHaveBeenCalledTimes(3);
    const unrelated = Object.assign(new Error("A caller error"), { code: "P2034" });
    transaction.mockReset().mockRejectedValue(unrelated);
    await expect(withSerializableTransaction(prisma, async () => null)).rejects.toBe(unrelated);
    expect(transaction).toHaveBeenCalledOnce();
  });
});

describe("private uploads", () => {
  let directory: string;
  let storage: ReturnType<typeof createUploadStorage>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "freightlink-uploads-"));
    storage = createUploadStorage(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("generates keys, detects signatures across chunks and retrieves only stored files", async () => {
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const saved = await storage.save("pod", Readable.from([image.subarray(0, 2), image.subarray(2)]));
    expect(saved).toMatchObject({ mimeType: "image/png", sizeBytes: 8, sha256: createHash("sha256").update(image).digest("hex") });
    expect(await readdir(directory)).toEqual([saved.storageKey]);
    expect(await buffer(await storage.open(saved.storageKey))).toEqual(image);
    await expect(storage.open("../../foreign-file")).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
    await storage.remove(saved.storageKey);
    await expect(storage.open(saved.storageKey)).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
  });

  it("accepts PDFs for insurance and rejects unsupported, truncated, and oversized files", async () => {
    const pdf = Buffer.from("%PDF-1.7\n");
    const insurance = await storage.save("insurance", Readable.from([pdf]));
    expect(insurance.mimeType).toBe("application/pdf");
    await expect(storage.save("pod", Readable.from([pdf]))).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    await expect(storage.save("insurance", Readable.from([Buffer.from("plain text")]))).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    const truncated = Object.assign(Readable.from([pdf]), { truncated: true });
    await expect(storage.save("insurance", truncated)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(storage.save("pod", Readable.from([Buffer.alloc(uploadLimits.pod + 1)]))).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(await readdir(directory)).toEqual([insurance.storageKey]);
  });
});

it("captures exact raw bytes only on opt-in routes and keeps Fastify's JSON parser and size limit", async () => {
  const app = Fastify();
  app.post("/raw", { preParsing: captureRawBody, bodyLimit: 64 }, (request) => ({
    raw: request.rawBody?.toString("hex"),
    parsed: request.body,
  }));
  app.post("/json", (request) => ({ raw: request.rawBody, parsed: request.body }));
  const payload = "{\n  \"sample\" : \"café\" }\n";
  const headers = { "content-type": "application/json" };
  try {
    const raw = await app.inject({ method: "POST", url: "/raw", headers, payload });
    expect(raw.json()).toEqual({ raw: Buffer.from(payload).toString("hex"), parsed: { sample: "café" } });
    const json = await app.inject({ method: "POST", url: "/json", headers, payload });
    expect(json.json()).toEqual({ parsed: { sample: "café" } });
    expect((await app.inject({ method: "POST", url: "/raw", headers, payload: JSON.stringify("a".repeat(65)) })).statusCode).toBe(413);
  } finally {
    await app.close();
  }
});

it("refuses to use a development database for integration tests", () => {
  const testUrl = "postgresql://freightlink_test@localhost:55433/freightlink_test";
  expect(requireTestDatabaseUrl({ TEST_DATABASE_URL: testUrl })).toBe(testUrl);
  expect(() => requireTestDatabaseUrl({ DATABASE_URL: testUrl })).toThrow(/Set TEST_DATABASE_URL/);
  expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: "postgresql://freightlink@localhost/freightlink" })).toThrow(/freightlink_test/);
  expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: testUrl, DATABASE_URL: testUrl })).toThrow(/different names/);
});

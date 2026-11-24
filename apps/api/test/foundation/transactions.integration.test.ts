import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { withSerializableTransaction } from "../../src/shared/transactions.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const userId = randomUUID();
let app: ReturnType<typeof buildApp>;

const conflictStatements = {
  serialization: Prisma.sql`DO $$ BEGIN RAISE EXCEPTION SQLSTATE '40001'; END $$`,
  deadlock: Prisma.sql`DO $$ BEGIN RAISE EXCEPTION SQLSTATE '40P01'; END $$`,
  rowLock: Prisma.sql`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE NOWAIT`,
};

async function failAtCommit(tx: Prisma.TransactionClient) {
  // A deferred trigger fails COMMIT after the transaction callback completes.
  await tx.$executeRaw`CREATE TEMP TABLE transaction_conflict_fixture (id int) ON COMMIT DROP`;
  await tx.$executeRaw`CREATE FUNCTION pg_temp.reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION SQLSTATE '40001'; END $$`;
  await tx.$executeRaw`CREATE CONSTRAINT TRIGGER reject_commit AFTER INSERT ON transaction_conflict_fixture
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_commit()`;
  await tx.$executeRaw`INSERT INTO transaction_conflict_fixture VALUES (1)`;
}

const attempts = new Map<string, number>();
beforeAll(async () => {
  app = buildApp(readConfig({ NODE_ENV: "test", DATABASE_URL: requireTestDatabaseUrl(), JWT_SECRET: randomUUID() }), async (routes) => {
    routes.post<{ Params: { scenario: keyof typeof conflictStatements | "commit" } }>("/transaction-fixture/:scenario", async (request) => {
      const { scenario } = request.params;
      await withSerializableTransaction(routes.prisma, async (tx) => {
        attempts.set(scenario, (attempts.get(scenario) ?? 0) + 1);
        if (scenario === "commit") await failAtCommit(tx);
        else await tx.$queryRaw(conflictStatements[scenario]);
      });
    });
  });
  await app.ready();
  await app.prisma.user.create({
    data: { id: userId, email: `${userId}@example.test`, displayName: "Transaction fixture", role: "SHIPPER", passwordHash: "fixture" },
  });
});

afterAll(async () => {
  try {
    await app?.prisma?.user.deleteMany({ where: { id: userId } });
  } finally {
    await app?.close();
  }
});

async function expectExhausted(scenario: string) {
  const response = await app.inject({ method: "POST", url: `/api/v1/transaction-fixture/${scenario}` });
  expect(response.statusCode, response.body).toBe(503);
  expect(response.json().error).toMatchObject({ code: "CONCURRENT_UPDATE", requestId: expect.any(String) });
  expect(attempts.get(scenario)).toBe(5);
}

it.each(["serialization", "deadlock", "commit"])("retries PostgreSQL %s failures before returning 503", expectExhausted);

it("retries SELECT FOR UPDATE NOWAIT while another transaction holds the row lock", async () => {
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = app.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
    locked.resolve();
    await release.promise;
  });
  try {
    await Promise.race([locked.promise, holder]);
    await expectExhausted("rowLock");
  } finally {
    release.resolve();
    await holder;
  }
});

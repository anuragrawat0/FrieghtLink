import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const prefix = `seed-production-${randomUUID()}-`;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp(readConfig({
    NODE_ENV: "test", DATABASE_URL: requireTestDatabaseUrl(), JWT_SECRET: randomUUID(),
  }));
  await app.ready();
});

afterAll(async () => {
  try {
    if (app?.prisma) {
      await app.prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
    }
  } finally {
    await app?.close();
  }
});

it("skips the demo admin seed when NODE_ENV is production", async () => {
  const email = `${prefix}admin@example.test`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: requireTestDatabaseUrl(),
      DEMO_ADMIN_EMAIL: email,
      DEMO_ADMIN_PASSWORD: "production seed password 123",
    },
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("Skipping the demo admin seed in production.");
  expect(await app.prisma.user.count({ where: { email } })).toBe(0);
});

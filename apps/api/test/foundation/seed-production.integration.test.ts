import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const prefix = `seed-production-${randomUUID()}-`;
const password = "production seed password 123";
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

function runSeed(email: string, password: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: requireTestDatabaseUrl(),
      DEMO_ADMIN_EMAIL: email,
      DEMO_ADMIN_PASSWORD: password,
    },
    encoding: "utf8",
  });
}

it.each(["email", "password"])("quietly skips the production seed when the demo admin %s is empty", async (empty) => {
  const email = `${prefix}empty-${empty}@example.test`;
  const result = runSeed(empty === "email" ? "" : email, empty === "password" ? "" : password);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(await app.prisma.user.count({ where: { email: { in: [email, ""] } } })).toBe(0);
});

it("seeds a configured admin in production who can log in", async () => {
  const email = `${prefix}admin@example.test`;
  const result = runSeed(email, password);
  expect(result.status, result.stderr).toBe(0);

  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  expect(response.json().data.user).toMatchObject({ email, role: "ADMIN" });
});

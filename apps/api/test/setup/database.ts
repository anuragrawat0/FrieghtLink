import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadLocalEnv } from "../../src/config.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";

export function requireTestDatabaseUrl(env?: NodeJS.ProcessEnv) {
  if (!env) {
    loadLocalEnv();
    env = process.env;
  }
  const databaseUrl = env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("Set TEST_DATABASE_URL to the isolated PostgreSQL test database.");

  let testUrl: URL;
  let developmentDatabase: string | undefined;
  try {
    testUrl = new URL(databaseUrl);
    developmentDatabase = env.DATABASE_URL ? decodeURIComponent(new URL(env.DATABASE_URL).pathname) : undefined;
  } catch {
    throw new Error("DATABASE_URL and TEST_DATABASE_URL must be valid URLs when set.");
  }
  if (!["postgres:", "postgresql:"].includes(testUrl.protocol) || !testUrl.hostname || testUrl.pathname !== "/freightlink_test" || testUrl.username !== "freightlink_test") {
    throw new Error("TEST_DATABASE_URL must use the freightlink_test database and user.");
  }
  if (developmentDatabase === testUrl.pathname) {
    throw new Error("The development and test databases must have different names.");
  }
  return databaseUrl;
}

export default async function setup() {
  const databaseUrl = requireTestDatabaseUrl();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 }) });
  try {
    const [target] = await prisma.$queryRaw<{ database: string; username: string }[]>`
      SELECT current_database()::text AS database, current_user::text AS username
    `;
    if (target?.database !== "freightlink_test" || target.username !== "freightlink_test") {
      throw new Error("The PostgreSQL connection does not point to the FreightLink test database and user.");
    }
  } finally {
    await prisma.$disconnect();
  }

  const cli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  execFileSync(process.execPath, [cli, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
    timeout: 60_000,
  });
}

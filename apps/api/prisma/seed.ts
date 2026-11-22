import Fastify from "fastify";
import { ConfigError, loadLocalEnv } from "../src/config.js";
import { seedDemoAdmin } from "../src/modules/auth/admin-seed.js";
import { prismaPlugin } from "../src/plugins/prisma.js";
import { errorContext } from "../src/shared/errors.js";

async function main() {
  loadLocalEnv();
  if (!process.env.DEMO_ADMIN_EMAIL?.trim() || !process.env.DEMO_ADMIN_PASSWORD) return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError("DATABASE_URL must be set before seeding.");

  const app = Fastify();
  try {
    app.register(prismaPlugin, { databaseUrl });
    await app.ready();
    await seedDemoAdmin(app.prisma);
    console.log("Demo admin is ready.");
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else console.error("Demo admin seed failed", errorContext(error));
  process.exitCode = 1;
});

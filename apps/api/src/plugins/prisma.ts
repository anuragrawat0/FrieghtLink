import fp from "fastify-plugin";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export const prismaPlugin = fp<{ databaseUrl: string }>(async (app, { databaseUrl }) => {
  const adapter = new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  const prisma = new PrismaClient({ adapter });

  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
  await prisma.$connect();
}, { name: "freightlink-prisma" });

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyPluginAsync, type FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config.js";
import { registerModules } from "./modules/index.js";
import { authPlugin } from "./plugins/auth.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { configureRateLimit } from "./plugins/rate-limit.js";
import { socketPlugin } from "./plugins/socket.js";
import { AppError, configureErrorHandling, errorResponseSchema } from "./shared/errors.js";
import { createUploadStorage, uploadLimits } from "./shared/uploads.js";

declare module "fastify" {
  interface FastifyInstance {
    uploads: ReturnType<typeof createUploadStorage>;
  }
}

export function buildApp(config: AppConfig, modules: FastifyPluginAsync = registerModules) {
  const options: FastifyServerOptions = {
    requestIdHeader: false,
    logger: config.nodeEnv !== "test" && {
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['stripe-signature']"],
      serializers: {
        req: (request) => ({ method: request.method, path: request.url?.split("?")[0] }),
      },
    },
    ajv: { customOptions: { removeAdditional: false } },
  };
  const app = Fastify(options);

  configureErrorHandling(app);
  app.register(cors, { origin: config.webOrigin, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS"] });
  app.register(prismaPlugin, { databaseUrl: config.databaseUrl });
  app.register(authPlugin, { jwtSecret: config.jwtSecret });
  app.register(socketPlugin, { webOrigin: config.webOrigin });
  configureRateLimit(app);
  app.register(multipart, { limits: { files: 1, fields: 1, parts: 2, fileSize: uploadLimits.insurance + 1 } });
  app.decorate("uploads", createUploadStorage(config.uploadDir));

  const healthSchema = {
    querystring: { type: "object", properties: {}, additionalProperties: false },
    response: {
      200: {
        type: "object",
        required: ["data"],
        properties: {
          data: { type: "object", required: ["status"], properties: { status: { const: "ok" } } },
        },
      },
      503: errorResponseSchema,
    },
  };
  for (const url of ["/api/v1/health", "/health"]) {
    app.get(url, { schema: healthSchema }, async (request) => {
      try {
        await request.server.prisma.$queryRaw`SELECT 1`;
      } catch (error) {
        throw new AppError(503, "SERVICE_UNAVAILABLE", "The database is unavailable.", { cause: error });
      }
      return { data: { status: "ok" } };
    });
  }

  app.register(modules, { prefix: "/api/v1" });
  return app;
}

import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { AppError } from "../shared/errors.js";

export const authRateLimit = { max: 10, timeWindow: 60_000 };

export function configureRateLimit(app: FastifyInstance) {
  app.register(rateLimit, {
    global: false,
    ...authRateLimit,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => new AppError(429, "RATE_LIMITED", "Too many requests. Try again later."),
  });
}

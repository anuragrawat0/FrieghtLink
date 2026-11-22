import type { FastifyPluginAsync } from "fastify";
import { authRoutes } from "./auth/routes.js";
import { usersRoutes } from "./users/routes.js";

// Register business modules here. Their paths are relative to /api/v1.
export const registerModules: FastifyPluginAsync = async (app) => {
  app.register(authRoutes);
  app.register(usersRoutes);
};

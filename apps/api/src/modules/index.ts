import type { FastifyPluginAsync } from "fastify";
import { authRoutes } from "./auth/routes.js";
import { bidRoutes } from "./bids/routes.js";
import { billingRoutes } from "./billing/routes.js";
import { carriersRoutes } from "./carriers/routes.js";
import { loadsRoutes } from "./loads/routes.js";
import { shipmentRoutes } from "./shipments/routes.js";
import { usersRoutes } from "./users/routes.js";

// Register business modules here. Their paths are relative to /api/v1.
export const registerModules: FastifyPluginAsync = async (app) => {
  app.register(authRoutes);
  app.register(usersRoutes);
  app.register(carriersRoutes);
  app.register(loadsRoutes);
  app.register(bidRoutes);
  app.register(shipmentRoutes);
  app.register(billingRoutes);
};

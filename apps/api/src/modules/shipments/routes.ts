import type { FastifyPluginAsync } from "fastify";
import { errorResponseSchema } from "../../shared/errors.js";
import { shipmentListResponse, shipmentQuery } from "./schemas.js";
import { listShipments, type ShipmentQuery } from "./service.js";

export const shipmentRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ShipmentQuery }>("/shipments", {
    onRequest: app.authenticate,
    schema: { querystring: shipmentQuery, response: { 200: shipmentListResponse, "4xx": errorResponseSchema, "5xx": errorResponseSchema } },
  }, async (request) => listShipments(app.prisma, request.user!, request.query));
};

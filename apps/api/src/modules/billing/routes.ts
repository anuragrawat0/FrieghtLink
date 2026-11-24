import type { FastifyPluginAsync } from "fastify";
import { errorResponseSchema } from "../../shared/errors.js";
import { emptyObject } from "../../shared/http-schemas.js";
import { invoiceDetailResponse, invoiceParams } from "./schemas.js";
import { readInvoiceDetail } from "./service.js";

export const billingRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { invoiceId: string } }>("/invoices/:invoiceId", {
    onRequest: app.authenticate,
    schema: { params: invoiceParams, querystring: emptyObject,
      response: { 200: invoiceDetailResponse, "4xx": errorResponseSchema, "5xx": errorResponseSchema } },
  }, async (request) => ({ data: await readInvoiceDetail(app.prisma, request.user!, request.params.invoiceId) }));
};

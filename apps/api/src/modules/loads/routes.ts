import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { AppError } from "../../shared/errors.js";
import { emptyObject, errorResponses, listResponse, loadFields, loadInput, loadParams, loadPatch, loadQuery, loadResponse } from "./schemas.js";
import { cancelLoad, createLoad, listLoads, publishLoad, readLoad, updateLoad, type LoadInput, type LoadQuery } from "./service.js";

type LoadParams = { loadId: string };

async function normalizeLoadInput(request: FastifyRequest) {
  const invalid = () => new AppError(400, "VALIDATION_ERROR", "The request is invalid.");
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw invalid();
  const fields = request.body as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(loadFields, key)) throw invalid();
    const field = loadFields[key as keyof LoadInput];
    if (typeof value === "number" && field.type === "number" && Number.isFinite(value)) continue;
    if (typeof value !== "string" || field.type !== "string") throw invalid();
    switch (key) {
      case "pickupCity": case "deliveryCity": fields[key] = value.trim().replace(/\s+/g, " "); break;
      case "pickupRegion": case "deliveryRegion": fields[key] = value.trim().toUpperCase(); break;
      case "description": fields[key] = value.trim(); break;
      case "pickupReadyAt": case "deliveryBy": {
        const parsed = new Date(value);
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw invalid();
        break;
      }
    }
  }
}

export const loadsRoutes: FastifyPluginAsync = async (app) => {
  const read = { onRequest: app.authenticate };
  const write = { ...read, preHandler: app.authorize("SHIPPER") };

  app.post<{ Body: LoadInput }>("/loads", {
    ...write, preValidation: normalizeLoadInput,
    schema: { querystring: emptyObject, body: loadInput, response: { 201: loadResponse, ...errorResponses } },
  }, async (request, reply) => reply.code(201).send({ data: await createLoad(app.prisma, request.user!, request.body) }));

  app.get<{ Querystring: LoadQuery }>("/loads", {
    ...read, schema: { querystring: loadQuery, response: { 200: listResponse, ...errorResponses } },
  }, async (request) => listLoads(app.prisma, request.user!, request.query));

  app.get<{ Params: LoadParams }>("/loads/:loadId", {
    ...read, schema: { params: loadParams, querystring: emptyObject, response: { 200: loadResponse, ...errorResponses } },
  }, async (request) => ({ data: await readLoad(app.prisma, request.user!, request.params.loadId) }));

  app.patch<{ Params: LoadParams; Body: Partial<LoadInput> }>("/loads/:loadId", {
    ...write, preValidation: normalizeLoadInput,
    schema: { params: loadParams, querystring: emptyObject, body: loadPatch, response: { 200: loadResponse, ...errorResponses } },
  }, async (request) => ({ data: await updateLoad(app, request.user!, request.params.loadId, request.body) }));

  for (const [action, perform] of [["publish", publishLoad], ["cancel", cancelLoad]] as const) {
    app.post<{ Params: LoadParams }>(`/loads/:loadId/${action}`, {
      ...write,
      preValidation: async (request) => { if (request.body === undefined) request.body = {}; },
      schema: { params: loadParams, querystring: emptyObject, body: emptyObject, response: { 200: loadResponse, ...errorResponses } },
    }, async (request) => ({ data: await perform(app, request.user!, request.params.loadId) }));
  }
};

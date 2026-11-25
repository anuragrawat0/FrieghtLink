import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { AppError, errorResponseSchema } from "../../shared/errors.js";
import { emptyObject } from "../../shared/http-schemas.js";
import { uploadLimits } from "../../shared/uploads.js";
import { isUuid } from "../../shared/uuid.js";
import { completeShipment, openPod, removeUnreferencedPod } from "./pod.js";
import {
  checkpointInput, checkpointListResponse, checkpointQuery, checkpointResponse, podResponse,
  shipmentDetailResponse, shipmentListResponse, shipmentParams, shipmentQuery,
} from "./schemas.js";
import { listShipments, readAssignedShipment, readShipmentDetail, type Pagination, type ShipmentQuery } from "./service.js";
import { addCheckpoint, listCheckpoints, type CheckpointInput } from "./tracking.js";

type Params = { shipmentId: string };
const errors = { "4xx": errorResponseSchema, "5xx": errorResponseSchema };

async function validateCheckpointTypes(request: FastifyRequest) {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.entries(body).some(([key, value]) =>
      typeof value !== (key === "latitude" || key === "longitude" ? "number" : "string"))) {
    throw new AppError(400, "VALIDATION_ERROR", "The checkpoint payload is invalid.");
  }
}

function invalidPod() {
  return new AppError(400, "VALIDATION_ERROR", "Send one photo in the file field and one UUID in clientEventId.");
}

export const shipmentRoutes: FastifyPluginAsync = async (app) => {
  const auth = { onRequest: app.authenticate };
  const carrier = { ...auth, preHandler: app.authorize("CARRIER") };
  const scoped = { params: shipmentParams, querystring: emptyObject };

  app.get<{ Querystring: ShipmentQuery }>("/shipments", {
    ...auth, schema: { querystring: shipmentQuery, response: { 200: shipmentListResponse, ...errors } },
  }, async (request) => listShipments(app.prisma, request.user!, request.query));

  app.get<{ Params: Params }>("/shipments/:shipmentId", {
    ...auth, schema: { ...scoped, response: { 200: shipmentDetailResponse, ...errors } },
  }, async (request) => ({ data: await readShipmentDetail(app.prisma, request.user!, request.params.shipmentId) }));

  app.get<{ Params: Params; Querystring: Pagination }>("/shipments/:shipmentId/checkpoints", {
    ...auth, schema: { ...scoped, querystring: checkpointQuery, response: { 200: checkpointListResponse, ...errors } },
  }, async (request) => listCheckpoints(app.prisma, request.user!, request.params.shipmentId, request.query));

  app.post<{ Params: Params; Body: CheckpointInput }>("/shipments/:shipmentId/checkpoints", {
    ...carrier, preValidation: validateCheckpointTypes,
    schema: { ...scoped, body: checkpointInput, response: { 200: checkpointResponse, 201: checkpointResponse, ...errors } },
  }, async (request, reply) => {
    const { data, replay } = await addCheckpoint(app, request.user!, request.params.shipmentId, request.body);
    return reply.code(replay ? 200 : 201).send({ data });
  });

  app.post<{ Params: Params }>("/shipments/:shipmentId/pod", {
    ...carrier,
    schema: { ...scoped, response: { 200: podResponse, 201: podResponse, ...errors } },
  }, async (request, reply) => {
    const { shipmentId } = request.params;
    await readAssignedShipment(app.prisma, request.user!, shipmentId);
    let saved: Awaited<ReturnType<typeof app.uploads.save>> | undefined;
    let clientEventId: string | undefined;
    let invalid = false;
    try {
      for await (const part of request.parts({ limits: { parts: 3, fileSize: uploadLimits.pod + 1 } })) {
        if (part.type === "file" && part.fieldname === "file" && !saved) {
          saved = await app.uploads.save("pod", part.file);
        } else if (part.type === "field" && part.fieldname === "clientEventId" && !clientEventId && isUuid(part.value)) {
          clientEventId = part.value;
        } else {
          invalid = true;
          if (part.type === "file") part.file.resume();
        }
      }
      if (invalid || !saved || !clientEventId) throw invalidPod();
      const { data, replay } = await completeShipment(app, request.user!, shipmentId, clientEventId, saved);
      if (!replay) saved = undefined;
      reply.code(replay ? 200 : 201);
      return { data };
    } catch (error) {
      const { FilesLimitError, FieldsLimitError, PartsLimitError, InvalidMultipartContentTypeError } = app.multipartErrors;
      if (error instanceof FilesLimitError || error instanceof FieldsLimitError || error instanceof PartsLimitError) throw invalidPod();
      if (error instanceof InvalidMultipartContentTypeError) {
        throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "Send the photo as multipart form data.");
      }
      throw error;
    } finally {
      if (saved) await removeUnreferencedPod(app, saved.storageKey);
    }
  });

  app.get<{ Params: Params }>("/shipments/:shipmentId/pod/file", {
    ...auth, schema: { ...scoped, response: { 200: { type: "string", format: "binary" }, ...errors } },
  }, async (request, reply) => {
    const file = await openPod(app, request.user!, request.params.shipmentId);
    return reply.type(file.mimeType)
      .header("Content-Disposition", "attachment")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .send(file.stream);
  });
};

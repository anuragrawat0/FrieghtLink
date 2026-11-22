import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../shared/errors.js";
import { adminCarrier, adminQueue, dataResponse, emptyObject, errorResponses, insurance, profile, profileIdParams, profileInput, queueQuery, reviewInput } from "./schemas.js";
import {
  listAdminCarriers, openInsurance, readAdminCarrier, readOwnProfile, removeUnreferencedInsurance,
  replaceInsurance, reviewCarrier, submitVerification, updateProfile,
  type CarrierQuery, type ProfileInput, type ReviewInput,
} from "./service.js";

type ProfileParams = { carrierProfileId: string };

function invalidInput(message = "The request is invalid.") {
  return new AppError(400, "VALIDATION_ERROR", message);
}

async function normalizeCarrierInput(request: FastifyRequest) {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw invalidInput();
  const fields = request.body as Record<string, unknown>;
  for (const [name, value] of Object.entries(fields)) {
    if (name === "expectedRevision" ? typeof value !== "number" : typeof value !== "string") throw invalidInput();
  }
  if (typeof fields.motorCarrierLicense === "string") fields.motorCarrierLicense = fields.motorCarrierLicense.trim().toUpperCase();
  if (typeof fields.reviewNote === "string") fields.reviewNote = fields.reviewNote.trim();
}

function sendInsurance(reply: FastifyReply, file: Awaited<ReturnType<typeof openInsurance>>) {
  return reply.type(file.mimeType)
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Disposition", "attachment")
    .header("Cache-Control", "private, no-store")
    .send(file.stream);
}

const fileResponses = { 200: { type: "string", format: "binary" }, ...errorResponses };

export const carriersRoutes: FastifyPluginAsync = async (app) => {
  const carrier = { onRequest: app.authenticate, preHandler: app.authorize("CARRIER") };
  const admin = { onRequest: app.authenticate, preHandler: app.authorize("ADMIN") };

  app.get("/carriers/me", { ...carrier, schema: { querystring: emptyObject, response: dataResponse(profile) } },
    async (request) => ({ data: await readOwnProfile(app.prisma, request.user!) }));

  app.patch<{ Body: ProfileInput }>("/carriers/me", {
    ...carrier, preValidation: normalizeCarrierInput,
    schema: { querystring: emptyObject, body: profileInput, response: dataResponse(profile) },
  }, async (request) => ({ data: await updateProfile(app, request.user!, request.body) }));

  app.put("/carriers/me/insurance", {
    ...carrier,
    schema: { consumes: ["multipart/form-data"], querystring: emptyObject, response: dataResponse(insurance) },
  }, async (request) => {
    let saved: Awaited<ReturnType<typeof app.uploads.save>> | undefined;
    let invalid = false;
    try {
      for await (const part of request.parts()) {
        if (part.type === "file" && part.fieldname === "file" && !saved) {
          saved = await app.uploads.save("insurance", part.file);
        } else {
          invalid = true;
          if (part.type === "file") part.file.resume();
        }
      }
      if (!saved || invalid) throw invalidInput("Send exactly one insurance file in the file field.");
      return { data: await replaceInsurance(app, request.user!, saved) };
    } catch (error) {
      if (saved) await removeUnreferencedInsurance(app, saved.storageKey);
      const { FilesLimitError, FieldsLimitError, PartsLimitError } = app.multipartErrors;
      if (error instanceof FilesLimitError || error instanceof FieldsLimitError || error instanceof PartsLimitError) {
        throw invalidInput("Send exactly one insurance file in the file field.");
      }
      throw error;
    }
  });

  app.get("/carriers/me/insurance", { ...carrier, schema: { querystring: emptyObject, response: fileResponses } },
    async (request, reply) => sendInsurance(reply, await openInsurance(app, request.user!)));

  app.post("/carriers/me/verification", {
    ...carrier,
    preValidation: async (request) => { if (request.body === undefined) request.body = {}; },
    schema: { querystring: emptyObject, body: emptyObject, response: dataResponse(profile) },
  }, async (request) => ({ data: await submitVerification(app, request.user!) }));

  app.get<{ Querystring: CarrierQuery }>("/admin/carriers", {
    ...admin, schema: { querystring: queueQuery, response: { 200: adminQueue, ...errorResponses } },
  }, async (request) => listAdminCarriers(app.prisma, request.user!, request.query));

  app.get<{ Params: ProfileParams }>("/admin/carriers/:carrierProfileId", {
    ...admin, schema: { params: profileIdParams, querystring: emptyObject, response: dataResponse(adminCarrier) },
  }, async (request) => ({ data: await readAdminCarrier(app.prisma, request.user!, request.params.carrierProfileId) }));

  app.get<{ Params: ProfileParams }>("/admin/carriers/:carrierProfileId/insurance", {
    ...admin, schema: { params: profileIdParams, querystring: emptyObject, response: fileResponses },
  }, async (request, reply) => sendInsurance(reply, await openInsurance(app, request.user!, request.params.carrierProfileId)));

  app.post<{ Params: ProfileParams; Body: ReviewInput }>("/admin/carriers/:carrierProfileId/review", {
    ...admin, preValidation: normalizeCarrierInput,
    schema: { params: profileIdParams, querystring: emptyObject, body: reviewInput, response: dataResponse(profile) },
  }, async (request) => ({ data: await reviewCarrier(app, request.user!, request.params.carrierProfileId, request.body) }));
};

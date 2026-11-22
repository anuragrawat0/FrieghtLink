import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { authRateLimit } from "../../plugins/rate-limit.js";
import { AppError, errorResponseSchema } from "../../shared/errors.js";
import { userSchema } from "../users/schemas.js";
import { emailMaxLength, emailPattern, normalizeEmail, passwordLength } from "./credentials.js";
import { login, registerAccount, type LoginInput, type RegisterInput } from "./service.js";

const credentialProperties = {
  email: { type: "string", maxLength: emailMaxLength, pattern: emailPattern.source },
  password: { type: "string" },
} as const;

const authResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["user", "accessToken"],
      properties: { user: userSchema, accessToken: { type: "string" } },
    },
  },
} as const;

const querystring = { type: "object", additionalProperties: false, properties: {} } as const;

async function normalizeAuthInput(request: FastifyRequest) {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.values(body).some((value) => typeof value !== "string")) {
    throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.");
  }
  // Check the original types before Fastify's schema validator can coerce them.
  const fields = body as Record<string, string | undefined>;
  if (fields.email !== undefined) fields.email = normalizeEmail(fields.email);
  if (fields.displayName !== undefined) fields.displayName = fields.displayName.trim();
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: RegisterInput }>("/auth/register", {
    config: { rateLimit: authRateLimit },
    preValidation: normalizeAuthInput,
    schema: {
      querystring,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password", "displayName", "role"],
        properties: {
          ...credentialProperties,
          password: { ...credentialProperties.password, ...passwordLength },
          displayName: { type: "string", minLength: 1, maxLength: 100 },
          role: { type: "string", enum: ["SHIPPER", "CARRIER"] },
        },
      },
      response: { 201: authResponseSchema, "4xx": errorResponseSchema, "5xx": errorResponseSchema },
    },
  }, async (request, reply) => reply.code(201).send({ data: await registerAccount(app, request.body) }));

  app.post<{ Body: LoginInput }>("/auth/login", {
    config: { rateLimit: authRateLimit },
    preValidation: normalizeAuthInput,
    schema: {
      querystring,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password"],
        properties: credentialProperties,
      },
      response: { 200: authResponseSchema, "4xx": errorResponseSchema, "5xx": errorResponseSchema },
    },
  }, async (request) => ({ data: await login(app, request.body) }));
};

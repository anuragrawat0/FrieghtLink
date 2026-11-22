import type { FastifyPluginAsync } from "fastify";
import { errorResponseSchema } from "../../shared/errors.js";
import { userSchema } from "./schemas.js";
import { toUserDto } from "./service.js";

export const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get("/users/me", {
    onRequest: app.authenticate,
    schema: {
      querystring: { type: "object", additionalProperties: false, properties: {} },
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["data"],
          properties: { data: userSchema },
        },
        "4xx": errorResponseSchema,
        "5xx": errorResponseSchema,
      },
    },
  }, async (request) => {
    // The shared authenticate hook supplies the current account for this route.
    return { data: toUserDto(request.user!) };
  });
};

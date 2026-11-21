import type { FastifyInstance } from "fastify";

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

const requestErrors: Partial<Record<number, [code: string, message: string]>> = {
  400: ["VALIDATION_ERROR", "The request is invalid."],
  401: ["UNAUTHENTICATED", "A valid access token is required."],
  403: ["FORBIDDEN", "This action is unavailable to your role."],
  404: ["NOT_FOUND", "The requested resource was not found."],
  413: ["FILE_TOO_LARGE", "The request exceeds the permitted size."],
  415: ["UNSUPPORTED_FILE_TYPE", "The request uses an unsupported media type."],
  429: ["RATE_LIMITED", "Too many requests. Try again later."],
};

export const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "requestId"],
      properties: { code: { type: "string" }, message: { type: "string" }, requestId: { type: "string" } },
    },
  },
} as const;

export function errorContext(error: unknown) {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return { name, code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : undefined };
}

export function configureErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler(() => {
    throw new AppError(404, "NOT_FOUND", "The requested resource was not found.");
  });

  app.setErrorHandler((error, request, reply) => {
    const context = errorContext(error);
    const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
    let failure: AppError;
    if (error instanceof AppError) {
      failure = error;
    } else if (context.code === "P2034") {
      failure = new AppError(503, "CONCURRENT_UPDATE", "The resource changed concurrently. Try again.");
    } else if (typeof status === "number" && status >= 400 && status < 500) {
      const [code, message] = requestErrors[status] ?? ["VALIDATION_ERROR", "The request is invalid."];
      failure = new AppError(status, code, message);
    } else {
      failure = new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
    }

    if (failure.statusCode >= 500) {
      request.log.error({ failure: errorContext(error instanceof AppError && error.cause ? error.cause : error) }, "Request failed");
    }

    return reply.code(failure.statusCode).send({
      error: { code: failure.code, message: failure.message, requestId: request.id },
    });
  });
}

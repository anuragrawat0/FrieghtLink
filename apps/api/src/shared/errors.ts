import type { FastifyInstance } from "fastify";
import { Prisma } from "../generated/prisma/client.js";

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

const conflictSqlStates = new Set<unknown>(["40001", "40P01", "55P03"]);

function errorFields(value: unknown) {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function isTransactionConflict(error: unknown) {
  const pending = [error];
  const visited = new Set<object>();
  while (pending.length) {
    const candidate = pending.pop();
    const fields = errorFields(candidate);
    if (!fields || visited.has(fields)) continue;
    visited.add(fields);

    if ((candidate instanceof Prisma.PrismaClientKnownRequestError && fields.code === "P2034") ||
        fields.kind === "TransactionWriteConflict" ||
        [fields.code, fields.originalCode, fields.sqlState].some((code) => conflictSqlStates.has(code))) {
      return true;
    }
    // Prisma can wrap statement errors in meta. The adapter can also throw at COMMIT.
    pending.push(fields.meta, fields.driverAdapterError, fields.cause);
  }
  return false;
}

function safeCode(value: unknown) {
  return typeof value === "string" && /^[A-Z0-9_]+$/.test(value) ? value : undefined;
}

function driverCauseContext(cause: unknown) {
  const fields = errorFields(cause);
  if (!fields) return undefined;
  return {
    code: safeCode(fields.code),
    originalCode: safeCode(fields.originalCode),
    sqlState: safeCode(fields.sqlState),
    kind: fields.kind === "TransactionWriteConflict" || fields.kind === "postgres" ? fields.kind : undefined,
  };
}

export function errorContext(error: unknown) {
  const fields = errorFields(error);
  const meta = errorFields(fields?.meta);
  const adapter = meta?.driverAdapterError;
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    code: safeCode(fields?.code),
    // Prisma metadata may contain query details and values. Keep only identifiers and codes.
    meta: meta && {
      code: safeCode(meta.code),
      modelName: typeof meta.modelName === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(meta.modelName) ? meta.modelName : undefined,
      driverAdapterError: adapter instanceof Error ? { name: adapter.name, cause: driverCauseContext(adapter.cause) } : undefined,
    },
    cause: driverCauseContext(fields?.cause),
  };
}

export function configureErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler(() => {
    throw new AppError(404, "NOT_FOUND", "The requested resource was not found.");
  });

  app.setErrorHandler((error, request, reply) => {
    const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
    let failure: AppError;
    if (error instanceof AppError) {
      failure = error;
    } else if (isTransactionConflict(error)) {
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

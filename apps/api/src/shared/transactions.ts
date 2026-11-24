import { randomInt } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { isTransactionConflict } from "./errors.js";

const maxAttempts = 5;

// The callback runs again on conflict. Read current state inside it and keep I/O outside it.
export async function withSerializableTransaction<T>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      if (attempt + 1 === maxAttempts || !isTransactionConflict(error)) {
        throw error;
      }
      const backoffMs = Math.min(250, 20 * 2 ** attempt);
      await setTimeout(randomInt(0, backoffMs + 1));
    }
  }
}

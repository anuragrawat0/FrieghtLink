import { randomInt } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { isTransactionConflict } from "./errors.js";

// The callback runs again on conflict. Read current state inside it and keep I/O outside it.
export async function withSerializableTransaction<T>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      if (attempt >= 2 || !isTransactionConflict(error)) {
        throw error;
      }
      await setTimeout(randomInt(10, 31));
    }
  }
}

import { randomInt } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

// The callback runs again on conflict. Read current state inside it and keep I/O outside it.
export async function withSerializableTransaction<T>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034") {
        throw error;
      }
      await setTimeout(randomInt(10, 31));
    }
  }
}

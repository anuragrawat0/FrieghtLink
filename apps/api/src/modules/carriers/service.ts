import type { Prisma } from "../../generated/prisma/client.js";

export async function createDraftProfile(tx: Prisma.TransactionClient, userId: string) {
  await tx.carrierProfile.create({ data: { userId, verificationStatus: "DRAFT" } });
}

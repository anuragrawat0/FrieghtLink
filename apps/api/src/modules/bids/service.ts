import type { Prisma } from "../../generated/prisma/client.js";

export async function closeActiveBidsForLoad(tx: Prisma.TransactionClient, loadId: string) {
  const closed = await tx.bid.updateManyAndReturn({
    where: { loadId, status: "ACTIVE" }, data: { status: "CLOSED" }, select: { id: true },
  });
  return closed.map(({ id }) => id);
}

export async function carrierHasBidForLoad(db: Prisma.TransactionClient, loadId: string, carrierUserId: string) {
  const bid = await db.bid.findFirst({ where: { loadId, carrierProfile: { userId: carrierUserId } }, select: { id: true } });
  return bid !== null;
}

export function readClosedBidNotifications(tx: Prisma.TransactionClient, ids: string[]) {
  return tx.bid.findMany({
    where: { id: { in: ids } },
    select: { id: true, currentRevision: true, carrierProfile: { select: { userId: true } } },
  });
}

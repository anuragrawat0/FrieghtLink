import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { AuthenticatedUser } from "../../plugins/auth.js";

export function shipmentReadScope(user: AuthenticatedUser): Prisma.ShipmentWhereInput {
  if (user.role === "SHIPPER") return { load: { shipperId: user.id } };
  if (user.role === "CARRIER") return { carrierProfile: { userId: user.id } };
  return {};
}

export async function canReadShipment(prisma: PrismaClient, user: AuthenticatedUser, shipmentId: string): Promise<boolean> {
  const shipment = await prisma.shipment.findFirst({
    where: { id: shipmentId, ...shipmentReadScope(user) }, select: { id: true },
  });
  return shipment !== null;
}

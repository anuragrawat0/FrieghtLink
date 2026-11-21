import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { AuthenticatedUser } from "../../plugins/auth.js";

export async function canReadShipment(
  prisma: PrismaClient,
  user: AuthenticatedUser,
  shipmentId: string,
): Promise<boolean> {
  let scope: Prisma.ShipmentWhereInput = {};
  if (user.role === "SHIPPER") scope = { load: { shipperId: user.id } };
  if (user.role === "CARRIER") scope = { carrierProfile: { userId: user.id } };

  const shipment = await prisma.shipment.findFirst({ where: { id: shipmentId, ...scope }, select: { id: true } });
  return shipment !== null;
}

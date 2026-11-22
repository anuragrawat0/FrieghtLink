import { Prisma, type PrismaClient, type Role } from "../../generated/prisma/client.js";
import type { AuthenticatedUser } from "../../plugins/auth.js";
import { AppError } from "../../shared/errors.js";

const publicFields = { id: true, email: true, displayName: true, role: true, createdAt: true } satisfies Record<keyof AuthenticatedUser, true>;

export async function createUser(
  db: Prisma.TransactionClient,
  data: { email: string; displayName: string; role: Role; passwordHash: string },
) {
  try {
    return await db.user.create({ data, select: publicFields });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "EMAIL_IN_USE", "That email is already registered.");
    }
    throw error;
  }
}

export function findUserByEmail(prisma: PrismaClient, email: string) {
  return prisma.user.findUnique({ where: { email }, select: publicFields });
}

export function findCredentialsByEmail(prisma: PrismaClient, email: string) {
  return prisma.user.findUnique({ where: { email }, select: { ...publicFields, passwordHash: true } });
}

export function toUserDto({ id, email, displayName, role, createdAt }: AuthenticatedUser) {
  return { id, email, displayName, role, createdAt: createdAt.toISOString() };
}

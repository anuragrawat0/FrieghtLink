import type { FastifyInstance } from "fastify";
import type { AuthenticatedUser } from "../../plugins/auth.js";
import { AppError } from "../../shared/errors.js";
import { withSerializableTransaction } from "../../shared/transactions.js";
import { createDraftProfile } from "../carriers/service.js";
import { createUser, findCredentialsByEmail, toUserDto } from "../users/service.js";
import { hashPassword, verifyPassword } from "./credentials.js";

export type LoginInput = { email: string; password: string };
export type RegisterInput = LoginInput & { displayName: string; role: "SHIPPER" | "CARRIER" };

async function createAuthResponse(app: FastifyInstance, user: AuthenticatedUser) {
  return { user: toUserDto(user), accessToken: await app.auth.signAccessToken(user.id) };
}

export async function registerAccount(app: FastifyInstance, input: RegisterInput) {
  if (input.role !== "SHIPPER" && input.role !== "CARRIER") {
    throw new AppError(400, "VALIDATION_ERROR", "Select a shipper or carrier role.");
  }
  const { email, displayName, role } = input;
  const passwordHash = await hashPassword(input.password);
  const user = await withSerializableTransaction(app.prisma, async (tx) => {
    const account = await createUser(tx, { email, displayName, role, passwordHash });
    if (role === "CARRIER") await createDraftProfile(tx, account.id);
    return account;
  });
  return createAuthResponse(app, user);
}

export async function login(app: FastifyInstance, input: LoginInput) {
  const user = await findCredentialsByEmail(app.prisma, input.email);
  const verified = await verifyPassword(input.password, user?.passwordHash);
  if (!user || !verified) {
    throw new AppError(401, "INVALID_CREDENTIALS", "The email or password is incorrect.");
  }
  return createAuthResponse(app, user);
}

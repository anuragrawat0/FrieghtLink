import { ConfigError } from "../../config.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../shared/errors.js";
import { createUser, findUserByEmail } from "../users/service.js";
import { emailMaxLength, emailPattern, hashPassword, normalizeEmail, passwordLength } from "./credentials.js";

export async function seedDemoAdmin(prisma: PrismaClient, env: NodeJS.ProcessEnv = process.env) {
  const email = normalizeEmail(env.DEMO_ADMIN_EMAIL ?? "");
  if (email.length > emailMaxLength || !emailPattern.test(email)) {
    throw new ConfigError("DEMO_ADMIN_EMAIL must be a valid email address.");
  }
  const password = env.DEMO_ADMIN_PASSWORD ?? "";
  const length = [...password].length;
  if (length < passwordLength.minLength || length > passwordLength.maxLength) {
    throw new ConfigError("DEMO_ADMIN_PASSWORD must contain 12–128 characters.");
  }

  const existing = await findUserByEmail(prisma, email);
  if (existing) {
    if (existing.role === "ADMIN") return;
    throw new ConfigError("DEMO_ADMIN_EMAIL already belongs to a non-admin account.");
  }

  const passwordHash = await hashPassword(password);
  try {
    await createUser(prisma, { email, displayName: "Demo Admin", role: "ADMIN", passwordHash });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "EMAIL_IN_USE") throw error;
    const winner = await findUserByEmail(prisma, email);
    if (winner?.role === "ADMIN") return;
    if (winner) throw new ConfigError("DEMO_ADMIN_EMAIL already belongs to a non-admin account.");
    throw error;
  }
}

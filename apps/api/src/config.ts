import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  webOrigin: string;
  jwtSecret: string;
  uploadDir: string;
  stripe: { secretKey: string; webhookSecret: string } | null;
}

export class ConfigError extends Error {}

export function loadLocalEnv() {
  const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(envFile)) loadEnvFile(envFile);
}

function parseUrl(value: string, variable: string) {
  try {
    return new URL(value);
  } catch {
    throw new ConfigError(`${variable} must be a valid URL.`);
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new ConfigError("NODE_ENV must be development, test or production.");
  }

  const port = Number(env.PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("PORT must be an integer from 1 to 65535.");
  }

  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  const database = parseUrl(databaseUrl, "DATABASE_URL");
  if (!["postgresql:", "postgres:"].includes(database.protocol) || !database.hostname || database.pathname.length < 2) {
    throw new ConfigError("DATABASE_URL must identify a PostgreSQL host and database.");
  }

  const web = parseUrl(env.WEB_ORIGIN ?? "http://localhost:3000", "WEB_ORIGIN");
  if (!["https:", "http:"].includes(web.protocol) || web.pathname !== "/" || web.search || web.hash || web.username || web.password) {
    throw new ConfigError("WEB_ORIGIN must be an HTTP(S) origin without credentials, a path or a query.");
  }

  const jwtSecret = env.JWT_SECRET ?? "";
  if (Buffer.byteLength(jwtSecret, "utf8") < 32 || !jwtSecret.trim()) {
    throw new ConfigError("JWT_SECRET must contain at least 32 bytes of random secret material.");
  }

  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  if ((secretKey || webhookSecret) && (!/^(sk|rk)_test_\S+$/.test(secretKey) || !/^whsec_\S+$/.test(webhookSecret))) {
    throw new ConfigError("Set a Stripe test-mode key and webhook signing secret together, or leave both unset.");
  }

  return {
    nodeEnv,
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    databaseUrl,
    webOrigin: web.origin,
    jwtSecret,
    uploadDir: resolve(env.UPLOAD_DIR?.trim() || "./uploads"),
    stripe: secretKey ? { secretKey, webhookSecret } : null,
  };
}

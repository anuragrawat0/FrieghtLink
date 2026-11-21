import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { buildApp } from "./app.js";
import { ConfigError, loadLocalEnv, readConfig } from "./config.js";
import { errorContext } from "./shared/errors.js";

async function start() {
  loadLocalEnv();
  const config = readConfig();
  await mkdir(config.uploadDir, { recursive: true });
  await access(config.uploadDir, constants.W_OK);

  const app = buildApp(config);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }

  const shutdown = async () => {
    try {
      await app.close();
    } catch (error) {
      app.log.error({ failure: errorContext(error) }, "API shutdown failed");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

start().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else console.error("API startup failed", errorContext(error));
  process.exitCode = 1;
});

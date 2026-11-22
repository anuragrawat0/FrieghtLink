import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) loadEnvFile(envFile);

const onWindows = process.platform === "win32";
const children = new Set();
let stopping = false;

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;

  for (const child of children) {
    if (!child.pid) continue;
    // Each npm command runs its dev server through a shell. Stop the whole tree.
    if (onWindows) {
      const task = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore", windowsHide: true,
      });
      task.once("error", () => child.kill());
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
}

function run(workspace, args = []) {
  const child = spawn(process.execPath, [process.env.npm_execpath, "run", "dev", "--workspace", workspace, ...args], {
    detached: !onWindows,
    stdio: "inherit",
  });
  children.add(child);
  child.once("error", (error) => {
    children.delete(child);
    console.error(`Could not start ${workspace}: ${error.message}`);
    stop(1);
  });
  child.once("exit", (code) => {
    children.delete(child);
    stop(code ?? 1);
  });
}

function docker(args, stdio) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio, windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function portIsBusy(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve(true);
      else reject(error);
    });
    server.listen(port, () => server.close(() => resolve(false)));
  });
}

async function main() {
  if (!await docker(["compose", "up", "db", "-d", "--wait"], "inherit")) {
    if (!await docker(["info", "--format", "{{.ServerVersion}}"], "ignore")) {
      console.error("Start Docker Desktop first");
    }
    stop(1);
    return;
  }
  if (stopping) return;

  const webPort = process.env.WEB_PORT || "3000";
  const ports = [...new Set([Number(webPort), Number(process.env.PORT || "3001")])];
  const busy = (await Promise.all(ports.map(portIsBusy))).map((used, index) => used ? ports[index] : null)
    .filter((port) => port !== null);
  for (const port of busy) console.error(`Port ${port} is busy. Try docker compose stop api web`);
  if (busy.length) {
    stop(1);
    return;
  }
  if (stopping) return;

  run("@freightlink/api");
  run("@freightlink/web", ["--", "--port", webPort]);
}

process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));
main().catch((error) => {
  console.error(error.message);
  stop(1);
});

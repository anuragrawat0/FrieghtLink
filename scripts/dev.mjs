import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));
run("@freightlink/api");
run("@freightlink/web", ["--", "--port", process.env.WEB_PORT || "3000"]);

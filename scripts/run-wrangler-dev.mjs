import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const requiredEnvVars = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "ADMIN_PASSWORD"];
const missingEnvVars = requiredEnvVars.filter((name) => !process.env[name]);

if (missingEnvVars.length > 0) {
  console.error(
    `Missing required environment variables for local dev: ${missingEnvVars.join(", ")}. Configure them as persistent local environment variables and see README.md.`,
  );
  process.exit(1);
}

const wranglerCliPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const command = process.execPath;
const args = [wranglerCliPath, "dev", ...process.argv.slice(2)];

const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

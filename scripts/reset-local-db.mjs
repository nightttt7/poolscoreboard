import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const localStatePath = resolve(process.cwd(), ".wrangler", "state");

if (existsSync(localStatePath)) {
  rmSync(localStatePath, { recursive: true, force: true });
  console.log(`Removed local Wrangler state at ${localStatePath}`);
} else {
  console.log(`No local Wrangler state found at ${localStatePath}`);
}

console.log("Local D1 state reset. Re-apply migrations to bootstrap from zero.");
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PROJECT_NAME = "poolscoreboard";
const D1_DATABASE_NAME = "poolscoreboard-prod";

function runWrangler(args) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["wrangler", ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `wrangler ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

function listDatabases() {
  const output = runWrangler(["d1", "list", "--json"]);
  return JSON.parse(output);
}

function resolveDatabaseId(database) {
  return database.database_id || database.uuid || database.id;
}

let database = listDatabases().find((item) => item.name === D1_DATABASE_NAME);

if (!database) {
  console.log(`Creating remote D1 database ${D1_DATABASE_NAME} for ${PROJECT_NAME}...`);
  runWrangler(["d1", "create", D1_DATABASE_NAME]);
  database = listDatabases().find((item) => item.name === D1_DATABASE_NAME);
}

if (!database) {
  throw new Error(`Unable to resolve D1 database id for ${D1_DATABASE_NAME}`);
}

const databaseId = resolveDatabaseId(database);

if (!databaseId) {
  throw new Error(`D1 database ${D1_DATABASE_NAME} exists but returned no id`);
}

if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `CLOUDFLARE_D1_DATABASE_ID=${databaseId}\n`);
}

console.log(`Resolved ${D1_DATABASE_NAME} => ${databaseId}`);
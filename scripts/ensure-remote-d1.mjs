import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { getProjectDetails } from "./project-config.mjs";

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
const { d1DatabaseName, projectName } = getProjectDetails(packageJson.name);

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

let database = listDatabases().find((item) => item.name === d1DatabaseName);

if (!database) {
  console.log(`Creating remote D1 database ${d1DatabaseName} for ${projectName}...`);
  runWrangler(["d1", "create", d1DatabaseName]);
  database = listDatabases().find((item) => item.name === d1DatabaseName);
}

if (!database) {
  throw new Error(`Unable to resolve D1 database id for ${d1DatabaseName}`);
}

const databaseId = resolveDatabaseId(database);

if (!databaseId) {
  throw new Error(`D1 database ${d1DatabaseName} exists but returned no id`);
}

if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `CLOUDFLARE_D1_DATABASE_ID=${databaseId}\n`);
}

console.log(`Resolved ${d1DatabaseName} => ${databaseId}`);
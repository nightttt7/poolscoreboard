import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getProjectDetails } from "./project-config.mjs";

const packageJsonPath = resolve(process.cwd(), "package.json");
const wranglerPath = resolve(process.cwd(), "wrangler.jsonc");
const projectModulePath = resolve(process.cwd(), "src", "project.ts");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const details = getProjectDetails(packageJson.name);

const updatedPackageJson = {
  ...packageJson,
  name: details.projectName,
};

writeFileSync(packageJsonPath, `${JSON.stringify(updatedPackageJson, null, 2)}\n`);

const wranglerConfig = {
  $schema: "./node_modules/wrangler/config-schema.json",
  name: details.workerName,
  main: "src/app.ts",
  compatibility_date: "2025-09-06",
  workers_dev: true,
  observability: {
    enabled: true,
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: details.d1DatabaseName,
      database_id: details.d1DatabaseId,
      migrations_dir: "migrations",
    },
  ],
};

writeFileSync(wranglerPath, `${JSON.stringify(wranglerConfig, null, 2)}\n`);

const projectModule = [
  `export const PROJECT_NAME = ${JSON.stringify(details.projectName)};`,
  "export const WORKER_NAME = PROJECT_NAME;",
  `export const D1_DATABASE_NAME = ${JSON.stringify(details.d1DatabaseName)};`,
  `export const D1_DATABASE_ID = ${JSON.stringify(details.d1DatabaseId)};`,
  "",
].join("\n");

writeFileSync(projectModulePath, projectModule);

console.log(`Synchronized project configuration for ${details.projectName}`);

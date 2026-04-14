import { pbkdf2Sync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const ADMIN_USERNAME = "admin";
const PASSWORD_HASH_ITERATIONS = 600000;

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

function quoteSqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

if (!process.env.ADMIN_PASSWORD) {
  throw new Error("Missing ADMIN_PASSWORD environment variable");
}

const passwordSalt = randomBytes(16).toString("hex");
const passwordHash = pbkdf2Sync(
  process.env.ADMIN_PASSWORD,
  passwordSalt,
  PASSWORD_HASH_ITERATIONS,
  32,
  "sha256",
).toString("hex");

const adminUsernameSql = quoteSqlLiteral(ADMIN_USERNAME);
const adminNameSql = quoteSqlLiteral(ADMIN_USERNAME);
const passwordSaltSql = quoteSqlLiteral(passwordSalt);
const passwordHashSql = quoteSqlLiteral(passwordHash);

runWrangler([
  "d1",
  "execute",
  "DB",
  "--remote",
  "--command",
  [
    "INSERT INTO users (name, current_match_id, username, password_salt, password_hash, created_at, updated_at)",
    `VALUES (${adminNameSql}, NULL, ${adminUsernameSql}, ${passwordSaltSql}, ${passwordHashSql}, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000)`,
    "ON CONFLICT(username) DO UPDATE SET",
    `name = ${adminNameSql},`,
    "current_match_id = NULL,",
    `password_salt = ${passwordSaltSql},`,
    `password_hash = ${passwordHashSql},`,
    "updated_at = CAST(strftime('%s', 'now') AS integer) * 1000;",
  ].join(" "),
]);

console.log("Synchronized remote admin password from ADMIN_PASSWORD");

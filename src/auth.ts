import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { sessions, users } from "./db/schema";

export const ADMIN_USERNAME = "admin";

const encoder = new TextEncoder();
const SESSION_COOKIE_NAME = "session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const PASSWORD_HASH_ITERATIONS = 4000;

type Bindings = {
  DB: D1Database;
  ADMIN_PASSWORD: string;
};

type AppContext = Context<{ Bindings: Bindings }>;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToHex(bytes);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hashPassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: PASSWORD_HASH_ITERATIONS,
    },
    key,
    256,
  );

  return bytesToHex(new Uint8Array(derived));
}

function getDatabase(c: AppContext) {
  return drizzle(c.env.DB);
}

export async function ensureAdminUser(c: AppContext) {
  const db = getDatabase(c);
  const existingAdmin = await db.select().from(users).where(eq(users.username, ADMIN_USERNAME)).get();

  if (existingAdmin) {
    return existingAdmin;
  }

  const passwordSalt = randomHex(16);
  const passwordHash = await hashPassword(c.env.ADMIN_PASSWORD, passwordSalt);

  await db.insert(users).values({
    username: ADMIN_USERNAME,
    passwordSalt,
    passwordHash,
    createdAt: new Date(),
  });

  return db.select().from(users).where(eq(users.username, ADMIN_USERNAME)).get();
}

export async function getAuthenticatedUser(c: AppContext) {
  const db = getDatabase(c);
  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);

  if (!sessionToken) {
    return null;
  }

  const tokenHash = await sha256Hex(sessionToken);
  const activeSession = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .get();

  if (!activeSession) {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return null;
  }

  const user = await db.select().from(users).where(eq(users.id, activeSession.userId)).get();

  if (!user) {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return null;
  }

  return user;
}

export async function login(c: AppContext, username: string, password: string) {
  await ensureAdminUser(c);

  const db = getDatabase(c);
  const user = await db.select().from(users).where(eq(users.username, username)).get();

  if (!user) {
    return null;
  }

  const passwordHash = await hashPassword(password, user.passwordSalt);

  if (passwordHash !== user.passwordHash) {
    return null;
  }

  const sessionToken = randomHex(32);
  const tokenHash = await sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash,
    expiresAt,
    createdAt: new Date(),
  });

  setCookie(c, SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    expires: expiresAt,
  });

  return user;
}

export async function logout(c: AppContext) {
  const db = getDatabase(c);
  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);

  if (sessionToken) {
    const tokenHash = await sha256Hex(sessionToken);
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
}

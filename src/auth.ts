import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { sessions, users } from "./db/schema";

type Bindings = {
  DB: D1Database;
};

type AppContext = Context<{ Bindings: Bindings }>;

const encoder = new TextEncoder();
const SESSION_COOKIE_NAME = "session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

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

function getDatabase(c: AppContext) {
  return drizzle(c.env.DB);
}

async function createSession(c: AppContext, userId: number) {
  const db = getDatabase(c);
  const sessionToken = randomHex(32);
  const tokenHash = await sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    userId,
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

export async function upsertSessionUser(c: AppContext, name: string) {
  const db = getDatabase(c);
  const now = new Date();
  const existingUser = await getAuthenticatedUser(c);

  if (existingUser) {
    await db
      .update(users)
      .set({
        name,
        updatedAt: now,
      })
      .where(eq(users.id, existingUser.id));

    return {
      ...existingUser,
      name,
      updatedAt: now,
    };
  }

  const insertResult = await db.insert(users).values({
    name,
    currentMatchId: null,
    createdAt: now,
    updatedAt: now,
  });
  const insertedId = Number(insertResult.meta?.last_row_id);

  if (!Number.isInteger(insertedId) || insertedId <= 0) {
    throw new Error("unable to create user session");
  }

  await createSession(c, insertedId);

  const user = await db.select().from(users).where(eq(users.id, insertedId)).get();

  if (!user) {
    throw new Error("unable to create user session");
  }

  return user;
}

export async function clearSession(c: AppContext) {
  const db = getDatabase(c);
  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);

  if (sessionToken) {
    const tokenHash = await sha256Hex(sessionToken);
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
}

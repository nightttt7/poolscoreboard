declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    ADMIN_PASSWORD: string;
  }
}

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import app from "../src/app";
import { PROJECT_NAME } from "../src/project";

async function resetDatabase() {
  await env.DB.exec("DROP TABLE IF EXISTS frames");
  await env.DB.exec("DROP TABLE IF EXISTS matches");
  await env.DB.exec("DROP TABLE IF EXISTS sessions");
  await env.DB.exec("DROP TABLE IF EXISTS users");
  await env.DB.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, current_match_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
  );
  await env.DB.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))"
  );
  await env.DB.exec(
    "CREATE TABLE matches (id TEXT PRIMARY KEY NOT NULL, code TEXT NOT NULL UNIQUE, target_wins INTEGER NOT NULL DEFAULT 7, player1_user_id INTEGER, player1_name TEXT, player2_user_id INTEGER, player2_name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
  );
  await env.DB.exec(
    "CREATE TABLE frames (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, frame_number INTEGER NOT NULL, winner_slot INTEGER, player1_fouls INTEGER NOT NULL DEFAULT 0, player2_fouls INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (match_id) REFERENCES matches(id))"
  );
}

function cookieFrom(response: Response) {
  return response.headers.get("set-cookie")?.split(";")[0] ?? null;
}

describe("pool scoreboard app", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("renders the scoreboard shell", async () => {
    const res = await app.request("http://localhost/", undefined, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain(PROJECT_NAME);
    expect(html).toContain("双人台球计分板");
    expect(html).toContain("开启新比赛");
  });

  it("requires a cookie-backed session before mutating match data", async () => {
    const res = await app.request(
      "http://localhost/api/matches/current/target-wins",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 9 }),
      },
      env,
    );

    expect(res.status).toBe(401);
  });

  it("creates, joins, scores, and announces a match winner", async () => {
    const createRes = await app.request(
      "http://localhost/api/matches",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      },
      env,
    );

    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { match: { code: string; frames: Array<{ number: number }> } };
    const aliceCookie = cookieFrom(createRes);
    expect(aliceCookie).toBeTruthy();
    expect(createBody.match.code).toMatch(/^\d{2,}$/);
    expect(createBody.match.frames).toHaveLength(1);

    const joinRes = await app.request(
      "http://localhost/api/matches/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bob", code: createBody.match.code }),
      },
      env,
    );

    expect(joinRes.status).toBe(200);
    const bobCookie = cookieFrom(joinRes);
    expect(bobCookie).toBeTruthy();

    const targetRes = await app.request(
      "http://localhost/api/matches/current/target-wins",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: aliceCookie!,
        },
        body: JSON.stringify({ value: 2 }),
      },
      env,
    );
    expect(targetRes.status).toBe(200);

    const foulsRes = await app.request(
      "http://localhost/api/matches/current/frames/1/fouls",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: bobCookie!,
        },
        body: JSON.stringify({ slot: 2, value: 2 }),
      },
      env,
    );
    expect(foulsRes.status).toBe(200);

    const firstWinRes = await app.request(
      "http://localhost/api/matches/current/frames/1/winner",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: aliceCookie!,
        },
        body: JSON.stringify({ slot: 1 }),
      },
      env,
    );
    const firstWinBody = (await firstWinRes.json()) as {
      match: {
        frames: Array<{ number: number; winnerSlot: number | null; player2Fouls: number }>;
        totalWins: { 1: number; 2: number };
        winnerMessage: string | null;
      };
    };

    expect(firstWinRes.status).toBe(200);
    expect(firstWinBody.match.totalWins).toEqual({ 1: 1, 2: 0 });
    expect(firstWinBody.match.frames).toHaveLength(2);
    expect(firstWinBody.match.frames[0]).toMatchObject({ number: 1, winnerSlot: 1, player2Fouls: 2 });
    expect(firstWinBody.match.frames[1]).toMatchObject({ number: 2, winnerSlot: null });
    expect(firstWinBody.match.winnerMessage).toBeNull();

    const secondWinRes = await app.request(
      "http://localhost/api/matches/current/frames/2/winner",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: bobCookie!,
        },
        body: JSON.stringify({ slot: 1 }),
      },
      env,
    );
    const secondWinBody = (await secondWinRes.json()) as {
      match: {
        frames: Array<{ number: number }>;
        totalWins: { 1: number; 2: number };
        winnerSlot: number | null;
        winnerMessage: string | null;
      };
    };

    expect(secondWinRes.status).toBe(200);
    expect(secondWinBody.match.totalWins).toEqual({ 1: 2, 2: 0 });
    expect(secondWinBody.match.winnerSlot).toBe(1);
    expect(secondWinBody.match.frames).toHaveLength(2);
    expect(secondWinBody.match.winnerMessage).toContain("Alice赢得了本场比赛");
    expect(secondWinBody.match.winnerMessage).toContain("Alice 2 : Bob 0");
  });

  it("limits each user to one match and each match to two active players", async () => {
    const createRes = await app.request(
      "http://localhost/api/matches",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      },
      env,
    );
    const createBody = (await createRes.json()) as { match: { code: string } };
    const aliceCookie = cookieFrom(createRes);

    const secondCreateRes = await app.request(
      "http://localhost/api/matches",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: aliceCookie!,
        },
        body: JSON.stringify({ name: "Alice" }),
      },
      env,
    );
    expect(secondCreateRes.status).toBe(409);

    const bobJoinRes = await app.request(
      "http://localhost/api/matches/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bob", code: createBody.match.code }),
      },
      env,
    );
    expect(bobJoinRes.status).toBe(200);

    const charlieJoinRes = await app.request(
      "http://localhost/api/matches/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Charlie", code: createBody.match.code }),
      },
      env,
    );
    expect(charlieJoinRes.status).toBe(409);
  });

  it("supports leaving, rejoining, and stale cleanup", async () => {
    const createRes = await app.request(
      "http://localhost/api/matches",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      },
      env,
    );
    const createBody = (await createRes.json()) as { match: { code: string } };
    const aliceCookie = cookieFrom(createRes)!;

    const bobJoinRes = await app.request(
      "http://localhost/api/matches/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bob", code: createBody.match.code }),
      },
      env,
    );
    const bobCookie = cookieFrom(bobJoinRes)!;

    const bobLeaveRes = await app.request(
      "http://localhost/api/matches/current/leave",
      {
        method: "POST",
        headers: { cookie: bobCookie },
      },
      env,
    );
    expect(bobLeaveRes.status).toBe(200);
    const bobLeaveBody = (await bobLeaveRes.json()) as { match: null };
    expect(bobLeaveBody.match).toBeNull();

    const charlieJoinRes = await app.request(
      "http://localhost/api/matches/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Charlie", code: createBody.match.code }),
      },
      env,
    );
    expect(charlieJoinRes.status).toBe(200);

    await env.DB.exec("UPDATE matches SET updated_at = 0");

    const sessionRes = await app.request(
      "http://localhost/api/session",
      {
        headers: { cookie: aliceCookie },
      },
      env,
    );
    const sessionBody = (await sessionRes.json()) as { match: null; user: { name: string } | null };
    expect(sessionRes.status).toBe(200);
    expect(sessionBody.user).toMatchObject({ name: "Alice" });
    expect(sessionBody.match).toBeNull();

    const missingJoinRes = await app.request(
      "http://localhost/api/matches/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Dana", code: createBody.match.code }),
      },
      env,
    );
    expect(missingJoinRes.status).toBe(404);
  });
});

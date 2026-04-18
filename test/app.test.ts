declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    ADMIN_PASSWORD: string;
    MATCH_ROOM: DurableObjectNamespace;
  }
}

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import app from "../src/app";

async function resetDatabase() {
  await env.DB.exec("DROP TABLE IF EXISTS frames");
  await env.DB.exec("DROP TABLE IF EXISTS matches");
  await env.DB.exec("DROP TABLE IF EXISTS sessions");
  await env.DB.exec("DROP TABLE IF EXISTS users");
  await env.DB.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, current_match_id TEXT, username TEXT, password_salt TEXT, password_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
  );
  await env.DB.exec("CREATE UNIQUE INDEX users_username_unique ON users (username)");
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
  const PROJECT_NAME = "poolscoreboard";

  beforeEach(async () => {
    await resetDatabase();
  });

  it("renders the player shell without the admin password field", async () => {
    const res = await app.request("http://localhost/", undefined, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain(PROJECT_NAME);
    expect(html).toContain("台球计分板");
    expect(html).toContain("开启新比赛");
    expect(html).toContain("创建后把比赛编号告知另一位玩家即可。");
    expect(html).toContain("输入比赛编号");
    expect(html).not.toContain("管理员密码");
    expect(html).not.toContain("前往 Admin 页面");
    expect(html).not.toContain("输入名字即可开始，对手通过比赛编号加入。");
    expect(html).toContain("grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));");
  });

  it("renders a dedicated admin page", async () => {
    const res = await app.request("http://localhost/admin", undefined, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain(`${PROJECT_NAME} Admin`);
    expect(html).toContain("Admin 入口 · 固定账号");
    expect(html).toContain("管理员密码");
    expect(html).toContain("返回首页");
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

  it("keeps a separate admin login entry and blocks admin from joining matches", async () => {
    const loginRes = await app.request(
      "http://localhost/api/admin/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
      },
      env,
    );

    expect(loginRes.status).toBe(200);
    const adminCookie = cookieFrom(loginRes);
    expect(adminCookie).toBeTruthy();
    const loginBody = (await loginRes.json()) as { user: { name: string; isAdmin: boolean }; match: null };
    expect(loginBody).toEqual({
      user: { name: "admin", isAdmin: true },
      match: null,
    });

    const createRes = await app.request(
      "http://localhost/api/matches",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie!,
        },
        body: JSON.stringify({ name: "Alice" }),
      },
      env,
    );

    expect(createRes.status).toBe(403);
    await expect(createRes.json()).resolves.toEqual({ error: "管理员账号不能参与比赛" });
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

  it("handles duplicate foul and winner submissions without side effects", async () => {
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

    const joinRes = await app.request(
      "http://localhost/api/matches/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bob", code: createBody.match.code }),
      },
      env,
    );
    const bobCookie = cookieFrom(joinRes)!;

    const foulRes = await app.request(
      "http://localhost/api/matches/current/frames/1/fouls",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: bobCookie,
        },
        body: JSON.stringify({ slot: 2, value: 2 }),
      },
      env,
    );
    expect(foulRes.status).toBe(200);

    const repeatedFoulRes = await app.request(
      "http://localhost/api/matches/current/frames/1/fouls",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: bobCookie,
        },
        body: JSON.stringify({ slot: 2, value: 2 }),
      },
      env,
    );
    const repeatedFoulBody = (await repeatedFoulRes.json()) as {
      match: {
        frames: Array<{ number: number; player2Fouls: number }>;
      };
    };

    expect(repeatedFoulRes.status).toBe(200);
    expect(repeatedFoulBody.match.frames[0]).toMatchObject({ number: 1, player2Fouls: 2 });

    const winRes = await app.request(
      "http://localhost/api/matches/current/frames/1/winner",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: aliceCookie,
        },
        body: JSON.stringify({ slot: 1 }),
      },
      env,
    );
    expect(winRes.status).toBe(200);

    const repeatedWinRes = await app.request(
      "http://localhost/api/matches/current/frames/1/winner",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: aliceCookie,
        },
        body: JSON.stringify({ slot: 1 }),
      },
      env,
    );
    const repeatedWinBody = (await repeatedWinRes.json()) as {
      match: {
        frames: Array<{ number: number; winnerSlot: number | null; player2Fouls: number }>;
        totalWins: { 1: number; 2: number };
      };
    };

    expect(repeatedWinRes.status).toBe(200);
    expect(repeatedWinBody.match.totalWins).toEqual({ 1: 1, 2: 0 });
    expect(repeatedWinBody.match.frames).toHaveLength(2);
    expect(repeatedWinBody.match.frames[0]).toMatchObject({ number: 1, winnerSlot: 1, player2Fouls: 2 });
    expect(repeatedWinBody.match.frames[1]).toMatchObject({ number: 2, winnerSlot: null });
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

  it("rejects WebSocket upgrades without a session", async () => {
    const res = await app.request(
      "http://localhost/api/matches/current/socket",
      { headers: { upgrade: "websocket" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects WebSocket upgrades when the user has no current match", async () => {
    const createRes = await app.request(
      "http://localhost/api/matches",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Solo" }),
      },
      env,
    );
    const cookie = cookieFrom(createRes)!;

    const leaveRes = await app.request(
      "http://localhost/api/matches/current/leave",
      { method: "POST", headers: { cookie } },
      env,
    );
    expect(leaveRes.status).toBe(200);

    const res = await app.request(
      "http://localhost/api/matches/current/socket",
      { headers: { upgrade: "websocket", cookie } },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("notifies room subscribers when a match mutation succeeds", async () => {
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

    const joinRes = await app.request(
      "http://localhost/api/matches/join",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bob", code: createBody.match.code }),
      },
      env,
    );
    const bobCookie = cookieFrom(joinRes)!;

    const wsRes = await app.request(
      "http://localhost/api/matches/current/socket",
      { headers: { upgrade: "websocket", cookie: aliceCookie } },
      env,
    );
    expect(wsRes.status).toBe(101);
    const socket = wsRes.webSocket;
    expect(socket).toBeTruthy();

    const messages: string[] = [];
    const received = new Promise<string>((resolve) => {
      socket!.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : "";
        messages.push(data);
        resolve(data);
      });
    });

    socket!.accept();

    const winRes = await app.request(
      "http://localhost/api/matches/current/frames/1/winner",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: bobCookie },
        body: JSON.stringify({ slot: 2 }),
      },
      env,
    );
    expect(winRes.status).toBe(200);

    const data = await received;
    expect(JSON.parse(data)).toMatchObject({ type: "match-updated" });
    expect(messages.length).toBeGreaterThan(0);

    socket!.close(1000, "done");
  });
});

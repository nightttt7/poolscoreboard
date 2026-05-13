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
  await env.DB.exec("DROP TABLE IF EXISTS match_history");
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
    "CREATE TABLE matches (id TEXT PRIMARY KEY NOT NULL, code TEXT NOT NULL UNIQUE, target_wins INTEGER NOT NULL DEFAULT 7, opening_slot INTEGER NOT NULL DEFAULT 1, archive_version INTEGER NOT NULL DEFAULT 1, player1_user_id INTEGER, player1_name TEXT, player2_user_id INTEGER, player2_name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
  );
  await env.DB.exec(
    "CREATE TABLE frames (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, frame_number INTEGER NOT NULL, breaker_slot INTEGER, winner_slot INTEGER, player1_fouls INTEGER NOT NULL DEFAULT 0, player2_fouls INTEGER NOT NULL DEFAULT 0, ended_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (match_id) REFERENCES matches(id))"
  );
  await env.DB.exec(
    "CREATE TABLE match_history (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, archive_version INTEGER NOT NULL, code TEXT NOT NULL, status TEXT NOT NULL, winner_slot INTEGER, target_wins INTEGER NOT NULL, player1_name TEXT, player2_name TEXT, player1_wins INTEGER NOT NULL, player2_wins INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER NOT NULL, snapshot TEXT NOT NULL)"
  );
  await env.DB.exec("CREATE UNIQUE INDEX match_history_match_archive_version_unique ON match_history (match_id, archive_version)");
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
    expect(html).toContain(String.raw`replace(/\{(\w+)\}/g`);
    expect(html).toContain('scoreValue.title = translate("totalScoreLabel")');
    expect(html).not.toContain("管理员密码");
    expect(html).not.toContain("前往 Admin 页面");
    expect(html).not.toContain("输入名字即可开始，对手通过比赛编号加入。");
    expect(html).not.toContain("总比分（只读）");
    expect(html).toContain("grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));");
  });

  it("renders a dedicated admin page", async () => {
    const res = await app.request("http://localhost/admin", undefined, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain(`${PROJECT_NAME} Admin`);
    expect(html).not.toContain("Admin 入口 · 固定账号");
    expect(html).toContain("管理员密码");
    expect(html).toContain("返回首页");
  });

  it("keeps the homepage scoreboard flow available for signed-in admin sessions", async () => {
    const res = await app.request("http://localhost/", undefined, env);

    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toMatch(/function renderSignedInAdminView\(\)\s*\{\s*renderLobby\(\);\s*\}/);
    expect(html).not.toMatch(/if\s*\(!matchCode\s*\|\|\s*isAdmin\)\s*\{/);
  });

  it("renders English when the browser prefers English", async () => {
    const res = await app.request(
      "http://localhost/",
      {
        headers: { "accept-language": "en-US,en;q=0.9" },
      },
      env,
    );

    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Pool Scoreboard");
    expect(html).toContain("Start a New Match");
    expect(html).toContain("Enter the match code");
    expect(html).toContain('data-locale="en-US"');
    expect(html).toContain('data-locale="zh-CN"');
    expect(html).not.toContain("开启新比赛");
  });

  it("prefers the locale cookie over the browser language", async () => {
    const res = await app.request(
      "http://localhost/",
      {
        headers: {
          cookie: "locale=zh-CN",
          "accept-language": "en-US,en;q=0.9",
        },
      },
      env,
    );

    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("台球计分板");
    expect(html).toContain("开启新比赛");
    expect(html).not.toContain("Pool Scoreboard");
  });

  it("stores the selected locale in a cookie and localizes API errors", async () => {
    const localeRes = await app.request(
      "http://localhost/api/locale",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: "en-US" }),
      },
      env,
    );

    expect(localeRes.status).toBe(200);
    expect(localeRes.headers.get("set-cookie")).toContain("locale=en-US");

    const localeCookie = cookieFrom(localeRes);
    expect(localeCookie).toBe("locale=en-US");

    const adminRes = await app.request(
      "http://localhost/api/admin/session",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: localeCookie!,
        },
        body: JSON.stringify({}),
      },
      env,
    );

    expect(adminRes.status).toBe(400);
    await expect(adminRes.json()).resolves.toEqual({ error: "Admin password is required" });
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

  it("keeps a separate admin login entry and allows admin to join matches", async () => {
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
    const createBody = (await createRes.json()) as { match: { code: string } };

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

    const joinRes = await app.request(
      "http://localhost/api/matches/join",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie!,
        },
        body: JSON.stringify({ name: "Admin Player", code: createBody.match.code }),
      },
      env,
    );

    expect(joinRes.status).toBe(200);
    const joinBody = (await joinRes.json()) as {
      user: { name: string; isAdmin: boolean };
      match: { code: string; targetWins: number; players: Array<{ name: string }> };
    };
    expect(joinBody.user).toEqual({ name: "Admin Player", isAdmin: true });
    expect(joinBody.match.code).toBe(createBody.match.code);
    expect(joinBody.match.targetWins).toBe(7);
    expect(joinBody.match.players.map((player) => player.name)).toEqual(["Alice", "Admin Player"]);

    const updateRes = await app.request(
      "http://localhost/api/matches/current/target-wins",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie!,
        },
        body: JSON.stringify({ value: 9 }),
      },
      env,
    );

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as { match: { targetWins: number } };
    expect(updateBody.match.targetWins).toBe(9);
  });

  it("requires an authenticated admin session before reading the admin dashboard", async () => {
    const res = await app.request("http://localhost/api/admin/dashboard", undefined, env);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "请先登录管理员账号" });
  });

  it("shows ongoing matches separately from archived completed matches in the admin dashboard", async () => {
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

    const targetRes = await app.request(
      "http://localhost/api/matches/current/target-wins",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: aliceCookie },
        body: JSON.stringify({ value: 1 }),
      },
      env,
    );
    expect(targetRes.status).toBe(200);

    const winRes = await app.request(
      "http://localhost/api/matches/current/frames/1/winner",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: bobCookie },
        body: JSON.stringify({ slot: 1 }),
      },
      env,
    );
    expect(winRes.status).toBe(200);

    const historyRows = await env.DB.prepare("SELECT code, status, archive_version FROM match_history").all<{
      code: string;
      status: string;
      archive_version: number;
    }>();
    expect(historyRows.results).toEqual([
      expect.objectContaining({
        code: createBody.match.code,
        status: "completed",
        archive_version: 1,
      }),
    ]);

    const secondCreateRes = await app.request(
      "http://localhost/api/matches",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Carol" }),
      },
      env,
    );
    const secondCreateBody = (await secondCreateRes.json()) as { match: { code: string } };
    expect(secondCreateRes.status).toBe(201);

    const adminLoginRes = await app.request(
      "http://localhost/api/admin/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
      },
      env,
    );
    const adminCookie = cookieFrom(adminLoginRes)!;

    const dashboardRes = await app.request(
      "http://localhost/api/admin/dashboard",
      {
        headers: { cookie: adminCookie },
      },
      env,
    );
    const dashboardBody = (await dashboardRes.json()) as {
      ongoingMatches: Array<{ code: string; status: string }>;
      historyMatches: Array<{
        code: string;
        status: string;
        winnerSlot: number | null;
        totalWins: { 1: number; 2: number };
        players: { 1: string | null; 2: string | null };
      }>;
    };

    expect(dashboardRes.status).toBe(200);
    expect(dashboardBody.ongoingMatches).toHaveLength(1);
    expect(dashboardBody.ongoingMatches[0]).toMatchObject({ code: secondCreateBody.match.code, status: "ongoing" });
    expect(dashboardBody.historyMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: createBody.match.code,
          status: "completed",
          winnerSlot: 1,
          totalWins: { 1: 1, 2: 0 },
          players: { 1: "Alice", 2: "Bob" },
        }),
      ]),
    );
  });

  it("archives a closed match when the final player leaves", async () => {
    const createRes = await app.request(
      "http://localhost/api/matches",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Solo" }),
      },
      env,
    );
    const createBody = (await createRes.json()) as { match: { code: string } };
    const soloCookie = cookieFrom(createRes)!;

    const leaveRes = await app.request(
      "http://localhost/api/matches/current/leave",
      {
        method: "POST",
        headers: { cookie: soloCookie },
      },
      env,
    );
    expect(leaveRes.status).toBe(200);

    const adminLoginRes = await app.request(
      "http://localhost/api/admin/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
      },
      env,
    );
    const adminCookie = cookieFrom(adminLoginRes)!;

    const dashboardRes = await app.request(
      "http://localhost/api/admin/dashboard",
      {
        headers: { cookie: adminCookie },
      },
      env,
    );
    const dashboardBody = (await dashboardRes.json()) as {
      historyMatches: Array<{
        code: string;
        status: string;
        players: { 1: string | null; 2: string | null };
      }>;
    };

    expect(dashboardRes.status).toBe(200);
    expect(dashboardBody.historyMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: createBody.match.code,
          status: "closed",
          players: { 1: "Solo", 2: null },
        }),
      ]),
    );
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
    const createBody = (await createRes.json()) as { match: { code: string; frames: Array<{ number: number; breakerSlot: number }> } };
    const aliceCookie = cookieFrom(createRes);
    expect(aliceCookie).toBeTruthy();
    expect(createBody.match.code).toMatch(/^\d{2,}$/);
    expect(createBody.match.frames).toHaveLength(1);
    expect(createBody.match.frames[0]).toMatchObject({ number: 1, breakerSlot: 1 });

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

    const breakerRes = await app.request(
      "http://localhost/api/matches/current/frames/1/breaker",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: aliceCookie!,
        },
        body: JSON.stringify({ slot: 2 }),
      },
      env,
    );
    const breakerBody = (await breakerRes.json()) as {
      match: {
        frames: Array<{ number: number; breakerSlot: number }>;
      };
    };

    expect(breakerRes.status).toBe(200);
    expect(breakerBody.match.frames[0]).toMatchObject({ number: 1, breakerSlot: 2 });

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
        frames: Array<{ number: number; breakerSlot: number; winnerSlot: number | null; player2Fouls: number }>;
        totalWins: { 1: number; 2: number };
        winnerMessage: string | null;
      };
    };

    expect(firstWinRes.status).toBe(200);
    expect(firstWinBody.match.totalWins).toEqual({ 1: 1, 2: 0 });
    expect(firstWinBody.match.frames).toHaveLength(2);
    expect(firstWinBody.match.frames[0]).toMatchObject({ number: 1, breakerSlot: 2, winnerSlot: 1, player2Fouls: 2 });
    expect(firstWinBody.match.frames[1]).toMatchObject({ number: 2, breakerSlot: 1, winnerSlot: null });
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

  it("alternates the default breaker slot across frames", async () => {
    const createRes = await app.request(
      "http://localhost/api/matches",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      },
      env,
    );
    const cookie = cookieFrom(createRes)!;

    const firstWinRes = await app.request(
      "http://localhost/api/matches/current/frames/1/winner",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ slot: 1 }),
      },
      env,
    );
    expect(firstWinRes.status).toBe(200);
    const firstWinBody = (await firstWinRes.json()) as {
      match: { frames: Array<{ number: number; breakerSlot: number }> };
    };
    expect(firstWinBody.match.frames[1]).toMatchObject({ number: 2, breakerSlot: 2 });

    const secondWinRes = await app.request(
      "http://localhost/api/matches/current/frames/2/winner",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ slot: 1 }),
      },
      env,
    );
    expect(secondWinRes.status).toBe(200);
    const secondWinBody = (await secondWinRes.json()) as {
      match: { frames: Array<{ number: number; breakerSlot: number }> };
    };
    expect(secondWinBody.match.frames[2]).toMatchObject({ number: 3, breakerSlot: 1 });
  });

  it("continues alternating from a manually changed breaker slot", async () => {
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
    expect(joinRes.status).toBe(200);

    const targetRes = await app.request(
      "http://localhost/api/matches/current/target-wins",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: aliceCookie },
        body: JSON.stringify({ value: 4 }),
      },
      env,
    );
    expect(targetRes.status).toBe(200);

    for (const frameNumber of [1, 2]) {
      const winRes = await app.request(
        `http://localhost/api/matches/current/frames/${frameNumber}/winner`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: aliceCookie },
          body: JSON.stringify({ slot: 1 }),
        },
        env,
      );
      expect(winRes.status).toBe(200);
    }

    const breakerRes = await app.request(
      "http://localhost/api/matches/current/frames/3/breaker",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: aliceCookie },
        body: JSON.stringify({ slot: 2 }),
      },
      env,
    );
    expect(breakerRes.status).toBe(200);

    const thirdWinRes = await app.request(
      "http://localhost/api/matches/current/frames/3/winner",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: aliceCookie },
        body: JSON.stringify({ slot: 1 }),
      },
      env,
    );
    expect(thirdWinRes.status).toBe(200);
    const thirdWinBody = (await thirdWinRes.json()) as {
      match: { frames: Array<{ number: number; breakerSlot: number }> };
    };
    expect(thirdWinBody.match.frames[2]).toMatchObject({ number: 3, breakerSlot: 2 });
    expect(thirdWinBody.match.frames[3]).toMatchObject({ number: 4, breakerSlot: 1 });
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

    const aliceLeaveRes = await app.request(
      "http://localhost/api/matches/current/leave",
      {
        method: "POST",
        headers: { cookie: aliceCookie },
      },
      env,
    );
    expect(aliceLeaveRes.status).toBe(200);
    const aliceLeaveBody = (await aliceLeaveRes.json()) as { match: null };
    expect(aliceLeaveBody.match).toBeNull();

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

    const bobSessionRes = await app.request(
      "http://localhost/api/session",
      {
        headers: { cookie: bobCookie },
      },
      env,
    );
    const bobSessionBody = (await bobSessionRes.json()) as {
      match: {
        frames: Array<{ number: number; breakerSlot: number }>;
      } | null;
    };

    expect(bobSessionRes.status).toBe(200);
    expect(bobSessionBody.match?.frames[0]).toMatchObject({ number: 1, breakerSlot: 2 });

    await env.DB.exec("UPDATE matches SET updated_at = 0");

    const sessionRes = await app.request(
      "http://localhost/api/session",
      {
        headers: { cookie: bobCookie },
      },
      env,
    );
    const sessionBody = (await sessionRes.json()) as { match: null; user: { name: string } | null };
    expect(sessionRes.status).toBe(200);
    expect(sessionBody.user).toMatchObject({ name: "Bob" });
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

  it("allows changing breaker even when only one player is in the match", async () => {
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

    const breakerRes = await app.request(
      "http://localhost/api/matches/current/frames/1/breaker",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ slot: 2 }),
      },
      env,
    );
    expect(breakerRes.status).toBe(200);
    const breakerBody = (await breakerRes.json()) as {
      match: { frames: Array<{ number: number; breakerSlot: number }> };
    };
    expect(breakerBody.match.frames[0]).toMatchObject({ number: 1, breakerSlot: 2 });
  });

  it("lets admins delete an archived match record", async () => {
    const createRes = await app.request(
      "http://localhost/api/matches",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Solo" }),
      },
      env,
    );
    const createBody = (await createRes.json()) as { match: { code: string } };
    const cookie = cookieFrom(createRes)!;

    const leaveRes = await app.request(
      "http://localhost/api/matches/current/leave",
      { method: "POST", headers: { cookie } },
      env,
    );
    expect(leaveRes.status).toBe(200);

    const adminLoginRes = await app.request(
      "http://localhost/api/admin/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
      },
      env,
    );
    const adminCookie = cookieFrom(adminLoginRes)!;

    const dashboardRes = await app.request(
      "http://localhost/api/admin/dashboard",
      { headers: { cookie: adminCookie } },
      env,
    );
    const dashboardBody = (await dashboardRes.json()) as {
      historyMatches: Array<{ matchId: string; archiveVersion: number; code: string }>;
    };
    const target = dashboardBody.historyMatches.find((m) => m.code === createBody.match.code);
    expect(target).toBeTruthy();

    const deleteRes = await app.request(
      `http://localhost/api/admin/history/${encodeURIComponent(target!.matchId)}/${target!.archiveVersion}`,
      { method: "DELETE", headers: { cookie: adminCookie } },
      env,
    );
    expect(deleteRes.status).toBe(200);

    const refreshed = await app.request(
      "http://localhost/api/admin/dashboard",
      { headers: { cookie: adminCookie } },
      env,
    );
    const refreshedBody = (await refreshed.json()) as {
      historyMatches: Array<{ code: string }>;
    };
    expect(refreshedBody.historyMatches.find((m) => m.code === createBody.match.code)).toBeUndefined();
  });

  it("requires admin auth to delete a history record", async () => {
    const res = await app.request(
      "http://localhost/api/admin/history/some-id/1",
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("lets admins force-end an active match and archives it as closed", async () => {
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

    const adminLoginRes = await app.request(
      "http://localhost/api/admin/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
      },
      env,
    );
    const adminCookie = cookieFrom(adminLoginRes)!;

    const dashboardRes = await app.request(
      "http://localhost/api/admin/dashboard",
      { headers: { cookie: adminCookie } },
      env,
    );
    const dashboardBody = (await dashboardRes.json()) as {
      ongoingMatches: Array<{ matchId: string; code: string }>;
    };
    const target = dashboardBody.ongoingMatches.find((m) => m.code === createBody.match.code);
    expect(target).toBeTruthy();

    const endRes = await app.request(
      `http://localhost/api/admin/matches/${encodeURIComponent(target!.matchId)}/force-end`,
      { method: "POST", headers: { cookie: adminCookie } },
      env,
    );
    expect(endRes.status).toBe(200);

    const refreshed = await app.request(
      "http://localhost/api/admin/dashboard",
      { headers: { cookie: adminCookie } },
      env,
    );
    const refreshedBody = (await refreshed.json()) as {
      ongoingMatches: Array<{ code: string }>;
      historyMatches: Array<{ code: string; status: string }>;
    };
    expect(refreshedBody.ongoingMatches.find((m) => m.code === createBody.match.code)).toBeUndefined();
    expect(refreshedBody.historyMatches.find((m) => m.code === createBody.match.code)).toMatchObject({
      status: "closed",
    });
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

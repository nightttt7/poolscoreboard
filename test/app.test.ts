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

describe("template app", () => {
  beforeEach(async () => {
    await env.DB.exec("DROP TABLE IF EXISTS sessions");
    await env.DB.exec("DROP TABLE IF EXISTS users");
    await env.DB.exec("DROP TABLE IF EXISTS todos");
    await env.DB.exec(
      "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)"
    );
    await env.DB.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))"
    );
    await env.DB.exec(
      "CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
    );
  });

  it("renders the minimal prototype page", async () => {
    const res = await app.request("http://localhost/", undefined, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain(PROJECT_NAME);
    expect(html).toContain("Prototype Board");
    expect(html).toContain("Log in");
  });

  it("rejects todo access before login", async () => {
    const res = await app.request("http://localhost/api/todos", undefined, env);
    expect(res.status).toBe(401);
  });

  it("creates, lists, and deletes todos after login", async () => {
    const loginRes = await app.request(
      "http://localhost/api/login",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: "admin", password: "test-admin-password" }),
      },
      env,
    );

    expect(loginRes.status).toBe(200);

    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const createRes = await app.request(
      "http://localhost/api/todos",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookie!,
        },
        body: JSON.stringify({ title: "Ship template" }),
      },
      env,
    );

    expect(createRes.status).toBe(201);

    const listRes = await app.request(
      "http://localhost/api/todos",
      {
        headers: {
          cookie: cookie!,
        },
      },
      env,
    );
    expect(listRes.status).toBe(200);

    const body = (await listRes.json()) as {
      items: Array<{ id: number; title: string; completed: boolean }>;
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 1,
      title: "Ship template",
      completed: false,
    });

    const deleteRes = await app.request(
      "http://localhost/api/todos/1",
      {
        method: "DELETE",
        headers: {
          cookie: cookie!,
        },
      },
      env,
    );

    expect(deleteRes.status).toBe(200);

    const remainingListRes = await app.request(
      "http://localhost/api/todos",
      {
        headers: {
          cookie: cookie!,
        },
      },
      env,
    );
    const remainingBody = (await remainingListRes.json()) as {
      items: Array<{ id: number; title: string; completed: boolean }>;
    };

    expect(remainingBody.items).toHaveLength(0);
  });
});

import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";

import { ADMIN_USERNAME, getAuthenticatedUser, login, logout } from "./auth";
import { todos } from "./db/schema";
import { D1_DATABASE_NAME, PROJECT_NAME, WORKER_NAME } from "./project";

type Bindings = {
  DB: D1Database;
  ADMIN_PASSWORD: string;
};

type AppContext = Context<{ Bindings: Bindings }>;

const app = new Hono<{ Bindings: Bindings }>();

async function requireUser(c: AppContext) {
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return { user: null, response: c.json({ error: "authentication required" }, 401) };
  }

  return { user, response: null };
}

function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${PROJECT_NAME}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe7;
        --card: rgba(255, 252, 247, 0.88);
        --ink: #1d1a17;
        --muted: #6a625b;
        --line: rgba(29, 26, 23, 0.12);
        --accent: #136f63;
        --accent-strong: #0e564d;
        --shadow: 0 24px 60px rgba(20, 18, 16, 0.14);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(19, 111, 99, 0.18), transparent 36%),
          radial-gradient(circle at bottom right, rgba(214, 124, 74, 0.2), transparent 30%),
          linear-gradient(180deg, #f9f4ed 0%, var(--bg) 100%);
      }
      main {
        width: min(920px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 48px 0 64px;
      }
      .hero, .panel {
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--card);
        box-shadow: var(--shadow);
        backdrop-filter: blur(12px);
      }
      .hero { padding: 28px; }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent-strong);
        background: rgba(19, 111, 99, 0.1);
      }
      h1 {
        margin: 18px 0 8px;
        font-size: clamp(2.2rem, 6vw, 4.4rem);
        line-height: 0.94;
      }
      p {
        margin: 0;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.6;
      }
      .hero-grid { gap: 18px; margin-top: 28px; }
      .chips { display: flex; flex-wrap: wrap; gap: 10px; }
      .chips span {
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(29, 26, 23, 0.05);
        color: var(--ink);
        font-size: 14px;
      }
      .layout {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 20px;
        margin-top: 20px;
      }
      .panel { padding: 22px; }
      .panel h2 { margin: 0 0 12px; font-size: 1.1rem; }
      form { display: grid; gap: 12px; }
      input, button { font: inherit; }
      input {
        width: 100%;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.9);
        color: var(--ink);
      }
      button {
        border: 0;
        border-radius: 16px;
        padding: 14px 18px;
        cursor: pointer;
        color: white;
        background: linear-gradient(135deg, var(--accent) 0%, #0b4a42 100%);
      }
      button:disabled { cursor: wait; opacity: 0.7; }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 12px;
      }
      li {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 12px;
        align-items: center;
        padding: 14px 16px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.7);
      }
      li[data-completed="true"] .todo-title {
        text-decoration: line-through;
        color: var(--muted);
      }
      .todo-meta { font-size: 12px; color: var(--muted); }
      .status { min-height: 24px; margin-top: 12px; font-size: 14px; color: var(--muted); }
      .mini-meta { display: grid; gap: 10px; }
      .mini-meta code {
        padding: 2px 6px;
        border-radius: 8px;
        background: rgba(29, 26, 23, 0.06);
      }
      @media (max-width: 820px) {
        .layout { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <span class="eyebrow">Cloudflare Workers Prototype</span>
        <h1>${PROJECT_NAME}</h1>
        <p>A minimal runnable prototype page backed by D1. It uses one simple table, a small HTML/CSS/JS shell, and live interaction against the Worker API.</p>
        <div class="hero-grid">
          <div class="chips">
            <span>Worker: ${WORKER_NAME}</span>
            <span>D1: ${D1_DATABASE_NAME}</span>
            <span>Runtime: Hono + Workers</span>
            <span>Tests: Vitest</span>
          </div>
        </div>
      </section>

      <section class="layout">
        <div class="panel">
          <h2>Prototype Board</h2>
          <div class="status" id="status">Checking session...</div>

          <section id="login-shell">
            <form id="login-form">
              <input id="username-input" name="username" value="${ADMIN_USERNAME}" autocomplete="username" required />
              <input id="password-input" name="password" type="password" placeholder="Password" autocomplete="current-password" required />
              <button id="login-button" type="submit">Log in</button>
            </form>
          </section>

          <section id="board-shell" hidden>
            <div class="todo-meta" id="session-label"></div>
            <div style="height: 12px"></div>
            <form id="todo-form">
              <input id="todo-input" name="title" maxlength="120" placeholder="Add the next prototype task" required />
              <button id="submit-button" type="submit">Create item</button>
            </form>
            <div style="height: 12px"></div>
            <button id="logout-button" type="button">Log out</button>
            <div style="height: 12px"></div>
            <ul id="todo-list"></ul>
          </section>
        </div>

        <aside class="panel">
          <h2>Runtime Notes</h2>
          <div class="mini-meta">
            <p>This page is intentionally small, but it already exercises the full loop: browser UI, Worker route, D1 persistence, and session-based login.</p>
            <p>Default deploy URL: <code>${WORKER_NAME}.&lt;your-workers-dev-subdomain&gt;.workers.dev</code></p>
            <p>Public visitors can open the page, but data-changing interactions require login. The initial account is <code>${ADMIN_USERNAME}</code>.</p>
          </div>
        </aside>
      </section>
    </main>

    <script>
      const loginShell = document.getElementById("login-shell");
      const boardShell = document.getElementById("board-shell");
      const loginForm = document.getElementById("login-form");
      const usernameInput = document.getElementById("username-input");
      const passwordInput = document.getElementById("password-input");
      const loginButton = document.getElementById("login-button");
      const form = document.getElementById("todo-form");
      const input = document.getElementById("todo-input");
      const list = document.getElementById("todo-list");
      const status = document.getElementById("status");
      const submitButton = document.getElementById("submit-button");
      const logoutButton = document.getElementById("logout-button");
      const sessionLabel = document.getElementById("session-label");

      function setStatus(message) {
        status.textContent = message;
      }

      async function parseResponsePayload(response) {
        const text = await response.text();

        if (!text) {
          return {};
        }

        try {
          return JSON.parse(text);
        } catch {
          throw new Error(text);
        }
      }

      function setAuthenticated(user) {
        const authenticated = Boolean(user);
        loginShell.hidden = authenticated;
        boardShell.hidden = !authenticated;
        sessionLabel.textContent = authenticated ? 'Logged in as ' + user.username : '';
      }

      function renderItems(items) {
        if (items.length === 0) {
          list.innerHTML = '<li><div class="todo-title">No items yet.</div><div class="todo-meta">Create the first prototype task above.</div><span></span></li>';
          return;
        }

        list.innerHTML = items.map((item) => {
          const createdAt = new Date(item.createdAt).toLocaleString();
          return [
            '<li>',
            '<input type="checkbox" data-id="' + item.id + '" aria-label="Delete todo" />',
            '<div>',
            '<div class="todo-title">' + item.title + '</div>',
            '<div class="todo-meta">Created ' + createdAt + '</div>',
            '</div>',
            '<span class="todo-meta">#' + item.id + '</span>',
            '</li>'
          ].join('');
        }).join('');
      }

      async function loadSession() {
        const response = await fetch('/api/session');
        const payload = await parseResponsePayload(response);
        setAuthenticated(payload.user || null);
        return payload.user || null;
      }

      async function loadItems() {
        setStatus("Loading items from D1...");
        const response = await fetch("/api/todos");

        if (response.status === 401) {
          setAuthenticated(null);
          setStatus('Please log in.');
          return;
        }

        const payload = await parseResponsePayload(response);
        renderItems(payload.items);
        setStatus("Ready.");
      }

      async function logIn(username, password) {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const payload = await parseResponsePayload(response);

        if (!response.ok) {
          throw new Error(payload.error || 'Unable to log in');
        }

        return payload.user;
      }

      async function logOut() {
        await fetch('/api/logout', { method: 'POST' });
      }

      async function createItem(title) {
        const response = await fetch("/api/todos", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title })
        });

        if (!response.ok) {
          const payload = await parseResponsePayload(response);
          throw new Error(payload.error || "Unable to create item");
        }
      }

      async function deleteItem(id) {
        const response = await fetch('/api/todos/' + id, {
          method: 'DELETE'
        });

        if (!response.ok) {
          throw new Error('Unable to delete item');
        }
      }

      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        loginButton.disabled = true;
        setStatus('Logging in...');

        try {
          const user = await logIn(usernameInput.value.trim(), passwordInput.value);
          setAuthenticated(user);
          passwordInput.value = '';
          await loadItems();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Unknown error');
        } finally {
          loginButton.disabled = false;
        }
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const title = input.value.trim();
        if (!title) {
          setStatus("Title is required.");
          return;
        }

        submitButton.disabled = true;
        setStatus("Creating item...");

        try {
          await createItem(title);
          input.value = "";
          await loadItems();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Unknown error");
        } finally {
          submitButton.disabled = false;
          input.focus();
        }
      });

      logoutButton.addEventListener('click', async () => {
        setStatus('Logging out...');
        await logOut();
        setAuthenticated(null);
        list.innerHTML = '';
        setStatus('Logged out.');
      });

      list.addEventListener("change", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
          return;
        }

        if (!target.checked) {
          return;
        }

        setStatus("Deleting item...");

        try {
          await deleteItem(target.dataset.id);
          await loadItems();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Unknown error");
          target.checked = !target.checked;
        }
      });

      loadSession()
        .then((user) => user ? loadItems() : setStatus('Please log in to view and modify data.'))
        .catch((error) => {
          setStatus(error instanceof Error ? error.message : 'Unable to connect to D1');
        });
    </script>
  </body>
</html>`;
}

app.get("/", (c) => {
  return c.html(renderHomePage());
});

app.get("/health", (c) => {
  return c.json({
    ok: true,
    projectName: PROJECT_NAME,
    workerName: WORKER_NAME,
    databaseName: D1_DATABASE_NAME,
  });
});

app.get("/api/session", async (c) => {
  const user = await getAuthenticatedUser(c);
  return c.json({
    user: user ? { username: user.username } : null,
  });
});

app.post("/api/login", async (c) => {
  if (!c.env.ADMIN_PASSWORD) {
    return c.json({ error: "ADMIN_PASSWORD secret is not configured" }, 500);
  }

  const payload = await c.req.json<{ username?: unknown; password?: unknown }>();

  if (typeof payload.username !== "string" || typeof payload.password !== "string") {
    return c.json({ error: "username and password are required" }, 400);
  }

  const user = await login(c, payload.username.trim(), payload.password);

  if (!user) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  return c.json({ user: { username: user.username } });
});

app.post("/api/logout", async (c) => {
  await logout(c);
  return c.json({ ok: true });
});

app.get("/api/todos", async (c) => {
  const auth = await requireUser(c);
  if (auth.response) {
    return auth.response;
  }

  const db = drizzle(c.env.DB);
  const items = await db.select().from(todos).orderBy(asc(todos.id));
  return c.json({ items });
});

app.post("/api/todos", async (c) => {
  const auth = await requireUser(c);
  if (auth.response) {
    return auth.response;
  }

  const payload = await c.req.json<{ title?: unknown }>();

  if (typeof payload.title !== "string" || payload.title.trim().length === 0) {
    return c.json({ error: "title is required" }, 400);
  }

  const db = drizzle(c.env.DB);
  const insertResult = await db.insert(todos).values({
    title: payload.title.trim(),
    completed: false,
    createdAt: new Date(),
  });
  const insertedIdValue = insertResult.meta?.last_row_id;

  if (insertedIdValue == null) {
    return c.json({ error: "todo created but could not load inserted row" }, 500);
  }

  const insertedId = Number(insertedIdValue);

  if (!Number.isInteger(insertedId) || insertedId <= 0) {
    return c.json({ error: "todo created but could not load inserted row" }, 500);
  }

  const item = await db.select().from(todos).where(eq(todos.id, insertedId)).get();

  if (!item) {
    return c.json({ error: "todo created but could not load inserted row" }, 500);
  }

  return c.json({ item }, 201);
});

app.delete("/api/todos/:id", async (c) => {
  const auth = await requireUser(c);
  if (auth.response) {
    return auth.response;
  }

  const id = Number(c.req.param("id"));

  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "invalid id" }, 400);
  }

  const db = drizzle(c.env.DB);
  const existing = await db.select().from(todos).where(eq(todos.id, id)).get();

  if (!existing) {
    return c.json({ error: "todo not found" }, 404);
  }

  await db.delete(todos).where(eq(todos.id, id));

  return c.json({ ok: true });
});

export default app;

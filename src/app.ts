import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";

import { clearSession, getAuthenticatedUser, isAdminUser, loginAdmin, upsertSessionUser } from "./auth";
import { frames, matches, users, type Frame, type Match, type User } from "./db/schema";
import { MatchRoom, matchRoomConnectUrl, matchRoomNotifyUrl } from "./match-room";

export { MatchRoom };

type Bindings = {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  MATCH_ROOM: DurableObjectNamespace;
};

type AppContext = Context<{ Bindings: Bindings }>;

type MatchState = {
  code: string;
  targetWins: number;
  players: Array<{
    slot: 1 | 2;
    name: string | null;
    occupied: boolean;
    isSelf: boolean;
  }>;
  frames: Array<{
    number: number;
    winnerSlot: 1 | 2 | null;
    player1Fouls: number;
    player2Fouls: number;
  }>;
  totalWins: {
    1: number;
    2: number;
  };
  winnerSlot: 1 | 2 | null;
  winnerMessage: string | null;
};

const app = new Hono<{ Bindings: Bindings }>();
const PROJECT_NAME = "poolscoreboard";
const DEFAULT_TARGET_WINS = 7;
const MAX_NAME_LENGTH = 24;
const MAX_TARGET_WINS = 99;
const MAX_FOULS = 99;
const MATCH_IDLE_TTL_MS = 1000 * 60 * 60 * 6;

function getDatabase(c: AppContext) {
  return drizzle(c.env.DB);
}

function normalizeName(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) {
    return null;
  }

  return trimmed;
}

function normalizeCode(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return /^\d{2,}$/.test(trimmed) ? trimmed : null;
}

function parseInteger(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function playerName(match: Match, slot: 1 | 2) {
  const name = slot === 1 ? match.player1Name : match.player2Name;
  return name || `玩家${slot}`;
}

function isFrameEmpty(frame: Frame) {
  return frame.winnerSlot == null && frame.player1Fouls === 0 && frame.player2Fouls === 0;
}

function calculateTotalWins(frameRows: Frame[]) {
  let player1 = 0;
  let player2 = 0;

  for (const frame of frameRows) {
    if (frame.winnerSlot === 1) {
      player1 += 1;
    } else if (frame.winnerSlot === 2) {
      player2 += 1;
    }
  }

  return {
    1: player1,
    2: player2,
  };
}

function determineWinnerSlot(match: Match, frameRows: Frame[]) {
  const totals = calculateTotalWins(frameRows);

  if (totals[1] >= match.targetWins) {
    return 1 as const;
  }

  if (totals[2] >= match.targetWins) {
    return 2 as const;
  }

  return null;
}

async function readJson<T>(c: AppContext) {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

async function cleanupStaleMatches(c: AppContext) {
  const db = getDatabase(c);
  const cutoff = new Date(Date.now() - MATCH_IDLE_TTL_MS);
  const staleMatches = await db
    .select({ id: matches.id })
    .from(matches)
    .where(
      or(
        and(isNull(matches.player1UserId), isNull(matches.player2UserId)),
        lt(matches.updatedAt, cutoff),
      ),
    )
    .all();

  if (staleMatches.length === 0) {
    return;
  }

  const staleIds = staleMatches.map((match) => match.id);
  const now = new Date();

  await db
    .update(users)
    .set({
      currentMatchId: null,
      updatedAt: now,
    })
    .where(inArray(users.currentMatchId, staleIds));

  await db.delete(frames).where(inArray(frames.matchId, staleIds));
  await db.delete(matches).where(inArray(matches.id, staleIds));
}

async function normalizeFrames(c: AppContext, match: Match) {
  const db = getDatabase(c);
  const frameRows = await db.select().from(frames).where(eq(frames.matchId, match.id)).orderBy(asc(frames.frameNumber)).all();

  if (frameRows.length === 0) {
    const now = new Date();
    await db.insert(frames).values({
      matchId: match.id,
      frameNumber: 1,
      winnerSlot: null,
      player1Fouls: 0,
      player2Fouls: 0,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  let working = frameRows.slice();
  const winnerSlot = determineWinnerSlot(match, working);

  if (winnerSlot) {
    while (working.length > 1 && isFrameEmpty(working[working.length - 1]!)) {
      const removable = working.pop();

      if (removable) {
        await db.delete(frames).where(eq(frames.id, removable.id));
      }
    }

    return;
  }

  while (
    working.length > 1
    && isFrameEmpty(working[working.length - 1]!)
    && isFrameEmpty(working[working.length - 2]!)
  ) {
    const removable = working.pop();

    if (removable) {
      await db.delete(frames).where(eq(frames.id, removable.id));
    }
  }

  const lastFrame = working[working.length - 1]!;

  if (lastFrame.winnerSlot != null) {
    const now = new Date();
    await db.insert(frames).values({
      matchId: match.id,
      frameNumber: lastFrame.frameNumber + 1,
      winnerSlot: null,
      player1Fouls: 0,
      player2Fouls: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function loadMatchState(c: AppContext, matchId: string, currentUserId: number | null) {
  const db = getDatabase(c);
  const match = await db.select().from(matches).where(eq(matches.id, matchId)).get();

  if (!match) {
    return null;
  }

  await normalizeFrames(c, match);
  const frameRows = await db.select().from(frames).where(eq(frames.matchId, match.id)).orderBy(asc(frames.frameNumber)).all();
  const totalWins = calculateTotalWins(frameRows);
  const winnerSlot = determineWinnerSlot(match, frameRows);
  const winnerMessage = winnerSlot
    ? `${playerName(match, winnerSlot)}赢得了本场比赛，比分为 ${playerName(match, 1)} ${totalWins[1]} : ${playerName(match, 2)} ${totalWins[2]}`
    : null;

  return {
    code: match.code,
    targetWins: match.targetWins,
    players: [
      {
        slot: 1 as const,
        name: match.player1UserId ? match.player1Name : null,
        occupied: Boolean(match.player1UserId),
        isSelf: match.player1UserId === currentUserId,
      },
      {
        slot: 2 as const,
        name: match.player2UserId ? match.player2Name : null,
        occupied: Boolean(match.player2UserId),
        isSelf: match.player2UserId === currentUserId,
      },
    ],
    frames: frameRows.map((frame) => ({
      number: frame.frameNumber,
      winnerSlot: frame.winnerSlot === 1 || frame.winnerSlot === 2 ? frame.winnerSlot : null,
      player1Fouls: frame.player1Fouls,
      player2Fouls: frame.player2Fouls,
    })),
    totalWins,
    winnerSlot,
    winnerMessage,
  } satisfies MatchState;
}

async function clearUserCurrentMatch(c: AppContext, userId: number) {
  const db = getDatabase(c);
  await db
    .update(users)
    .set({
      currentMatchId: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

async function loadCurrentMatchContext(c: AppContext, user: User) {
  if (!user.currentMatchId) {
    return null;
  }

  const db = getDatabase(c);
  const match = await db.select().from(matches).where(eq(matches.id, user.currentMatchId)).get();

  if (!match) {
    await clearUserCurrentMatch(c, user.id);
    return null;
  }

  const slot = match.player1UserId === user.id ? 1 : match.player2UserId === user.id ? 2 : null;

  if (!slot) {
    await clearUserCurrentMatch(c, user.id);
    return null;
  }

  return {
    match,
    slot: slot as 1 | 2,
  };
}

async function ensureCurrentMatch(c: AppContext) {
  await cleanupStaleMatches(c);
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return {
      user: null,
      context: null,
      response: c.json({ error: "需要先填写名字并进入比赛" }, 401),
    };
  }

  if (isAdminUser(user)) {
    return {
      user,
      context: null,
      response: adminMatchBlockedResponse(c),
    };
  }

  const context = await loadCurrentMatchContext(c, user);

  if (!context) {
    return {
      user,
      context: null,
      response: c.json({ error: "当前没有进行中的比赛" }, 404),
    };
  }

  return {
    user,
    context,
    response: null,
  };
}

async function generateMatchCode(c: AppContext) {
  const db = getDatabase(c);
  const existingCodes = new Set((await db.select({ code: matches.code }).from(matches).all()).map((match) => match.code));

  for (let digits = 2; digits <= 6; digits += 1) {
    const upperBound = 10 ** digits;
    const occupiedForDigits = Array.from(existingCodes).filter((code) => code.length === digits).length;

    if (occupiedForDigits >= upperBound) {
      continue;
    }

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = String(Math.floor(Math.random() * upperBound)).padStart(digits, "0");

      if (!existingCodes.has(candidate)) {
        return candidate;
      }
    }

    for (let candidateNumber = 0; candidateNumber < upperBound; candidateNumber += 1) {
      const candidate = String(candidateNumber).padStart(digits, "0");

      if (!existingCodes.has(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error("unable to allocate match code");
}

function serializeUser(user: User | null) {
  return user
    ? {
      name: user.name,
      isAdmin: isAdminUser(user),
    }
    : null;
}

function adminMatchBlockedResponse(c: AppContext) {
  return c.json({ error: "管理员账号不能参与比赛" }, 403);
}

async function respondWithCurrentState(c: AppContext, user: User) {
  const freshUser = await getDatabase(c).select().from(users).where(eq(users.id, user.id)).get();
  const currentUser = freshUser ?? user;
  const context = await loadCurrentMatchContext(c, currentUser);
  const matchState = context ? await loadMatchState(c, context.match.id, currentUser.id) : null;
  return c.json({ user: serializeUser(currentUser), match: matchState });
}

function getMatchRoomStub(c: AppContext, matchId: string) {
  const id = c.env.MATCH_ROOM.idFromName(matchId);
  return c.env.MATCH_ROOM.get(id);
}

function notifyMatchRoom(c: AppContext, matchId: string) {
  const stub = getMatchRoomStub(c, matchId);
  const task = stub.fetch(matchRoomNotifyUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "match-updated" }),
  });

  let executionCtx: ExecutionContext | null = null;
  try {
    executionCtx = c.executionCtx ?? null;
  } catch {
    executionCtx = null;
  }

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(task.then(() => undefined).catch(() => undefined));
  } else {
    void task.catch(() => undefined);
  }
}

function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${PROJECT_NAME}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #0f172a;
        --panel: rgba(15, 23, 42, 0.88);
        --panel-strong: #111827;
        --card: rgba(30, 41, 59, 0.95);
        --line: rgba(148, 163, 184, 0.22);
        --text: #f8fafc;
        --muted: #cbd5e1;
        --accent: #22c55e;
        --accent-soft: rgba(34, 197, 94, 0.18);
        --danger: #ef4444;
        --danger-soft: rgba(239, 68, 68, 0.16);
        --warning: #f59e0b;
        --button: #334155;
        --button-strong: #475569;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top, #1e293b, var(--bg) 48%);
        color: var(--text);
      }
      main {
        width: min(100%, 560px);
        margin: 0 auto;
        padding: 18px 14px 36px;
      }
      .stack { display: grid; gap: 14px; }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 18px;
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.45);
      }
      h1, h2, h3, p { margin: 0; }
      h1 { font-size: 2rem; }
      h2 { font-size: 1.05rem; margin-bottom: 12px; }
      p, label, .muted, .hint { color: var(--muted); }
      .hero { display: grid; gap: 8px; }
      .badge {
        display: inline-flex;
        width: fit-content;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(59, 130, 246, 0.16);
        color: #bfdbfe;
        font-size: 0.82rem;
      }
      .status {
        min-height: 24px;
        font-size: 0.95rem;
        color: #bfdbfe;
      }
      .lobby-grid, .match-stack, .score-grid, .frame-list { display: grid; gap: 12px; }
      .field { display: grid; gap: 8px; }
      .field input, .number-input {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: rgba(15, 23, 42, 0.9);
        color: var(--text);
        padding: 14px 16px;
        font-size: 1rem;
      }
      .field input::placeholder, .number-input::placeholder { color: #94a3b8; }
      button {
        border: 0;
        border-radius: 16px;
        background: var(--button);
        color: var(--text);
        padding: 14px 16px;
        font-size: 1rem;
        font-weight: 700;
      }
      button.primary { background: var(--accent); color: #052e16; }
      button.secondary { background: var(--button-strong); }
      button.danger { background: var(--danger); }
      button.ghost {
        background: transparent;
        border: 1px solid var(--line);
      }
      button.active {
        background: var(--accent);
        color: #052e16;
      }
      button:disabled, input:disabled {
        opacity: 0.7;
      }
      .button-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .match-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
      }
      .code {
        font-size: 2rem;
        font-weight: 800;
        letter-spacing: 0.16em;
      }
      .score-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .score-card, .frame-card, .stepper, .target-card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 14px;
      }
      .score-card strong {
        display: block;
        font-size: 2.2rem;
        margin-top: 6px;
      }
      .self-tag {
        display: inline-flex;
        margin-left: 8px;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(34, 197, 94, 0.16);
        color: #86efac;
        font-size: 0.78rem;
      }
      .target-card { display: grid; gap: 12px; }
      .target-card.pending, .stepper.pending {
        border-color: rgba(59, 130, 246, 0.28);
      }
      .stepper-row {
        display: grid;
        grid-template-columns: 52px minmax(0, 1fr) 52px;
        gap: 10px;
        align-items: center;
      }
      .stepper-row button { padding: 14px 0; }
      .stepper-row.pending button, .stepper-row.pending input {
        box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.18);
      }
      .stepper-row input {
        text-align: center;
        font-size: 1.15rem;
        font-weight: 700;
      }
      .frame-card {
        display: grid;
        gap: 12px;
      }
      .frame-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .winner-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .foul-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 10px;
      }
      .win-button {
        min-height: 54px;
        background: rgba(148, 163, 184, 0.18);
      }
      .winner-row.pending .win-button {
        box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.22);
      }
      .clear-button {
        padding: 10px 12px;
        font-size: 0.88rem;
      }
      .announcement {
        padding: 14px 16px;
        border-radius: 18px;
        background: var(--accent-soft);
        color: #dcfce7;
        border: 1px solid rgba(34, 197, 94, 0.28);
        font-weight: 700;
      }
      .empty-seat {
        padding: 12px 14px;
        border-radius: 18px;
        background: rgba(59, 130, 246, 0.14);
        color: #bfdbfe;
        border: 1px solid rgba(59, 130, 246, 0.22);
      }
      .footer-note {
        text-align: center;
        font-size: 0.82rem;
        color: #94a3b8;
      }
    </style>
  </head>
  <body>
    <main class="stack">
      <section class="panel hero">
        <span class="badge">手机优先 · 双人台球计分板</span>
        <h1>${PROJECT_NAME}</h1>
        <p>输入名字即可开始，对手通过比赛编号加入。</p>
      </section>
      <section class="panel">
        <div class="status" id="status">正在连接…</div>
      </section>
      <section class="panel" id="app-shell"></section>
      <p class="footer-note">${PROJECT_NAME}</p>
    </main>
    <script>
      const shell = document.getElementById("app-shell");
      const statusNode = document.getElementById("status");
      const state = {
        user: null,
        match: null,
        targetWinsPending: false,
        pendingWinners: {},
        pendingFouls: {},
      };

      function setStatus(message) {
        statusNode.textContent = message;
      }

      function readyStatus() {
        if (state.match) {
          return "已同步比赛状态。";
        }

        return state.user && state.user.isAdmin ? "已登录管理员账号。" : "准备开始新的比赛。";
      }

      function resetMatchInteractionState() {
        state.targetWinsPending = false;
        state.pendingWinners = {};
        state.pendingFouls = {};
      }

      function getFrame(frameNumber) {
        return state.match ? state.match.frames.find((frame) => frame.number === frameNumber) || null : null;
      }

      function winnerKey(frameNumber) {
        return String(frameNumber);
      }

      function foulKey(frameNumber, slot) {
        return frameNumber + ":" + slot;
      }

      function foulFrameNumberFromKey(key) {
        return key.split(":")[0];
      }

      function getDisplayedWinnerSlot(frame) {
        const pending = state.pendingWinners[winnerKey(frame.number)];
        return pending ? pending.optimisticSlot : frame.winnerSlot;
      }

      function getDisplayedFoulValue(frame, slot) {
        const pending = state.pendingFouls[foulKey(frame.number, slot)];

        if (pending) {
          return pending.optimisticValue;
        }

        return slot === 1 ? frame.player1Fouls : frame.player2Fouls;
      }

      function pruneInteractionState() {
        if (!state.match) {
          resetMatchInteractionState();
          return;
        }

        const activeFrames = new Set(state.match.frames.map((frame) => String(frame.number)));

        for (const key of Object.keys(state.pendingWinners)) {
          if (!activeFrames.has(key)) {
            delete state.pendingWinners[key];
          }
        }

        for (const key of Object.keys(state.pendingFouls)) {
          if (!activeFrames.has(foulFrameNumberFromKey(key))) {
            delete state.pendingFouls[key];
          }
        }
      }

      function make(tag, options = {}) {
        const node = document.createElement(tag);
        if (options.className) node.className = options.className;
        if (options.text != null) node.textContent = options.text;
        if (options.html != null) node.innerHTML = options.html;
        if (options.type) node.type = options.type;
        if (options.placeholder) node.placeholder = options.placeholder;
        if (options.value != null) node.value = String(options.value);
        if (options.min != null) node.min = String(options.min);
        if (options.max != null) node.max = String(options.max);
        if (options.inputMode) node.inputMode = options.inputMode;
        return node;
      }

      async function parsePayload(response) {
        const text = await response.text();
        if (!text) return {};
        return JSON.parse(text);
      }

      async function api(path, options = {}) {
        const headers = new Headers(options.headers || {});
        if (options.body != null && !headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }

        const response = await fetch(path, { ...options, headers });
        const payload = await parsePayload(response);

        if (!response.ok) {
          throw new Error(payload.error || "请求失败");
        }

        return payload;
      }

      function applyPayload(payload) {
        if (Object.prototype.hasOwnProperty.call(payload, "user")) {
          state.user = payload.user;
        }
        if (Object.prototype.hasOwnProperty.call(payload, "match")) {
          const previousCode = state.match ? state.match.code : null;
          state.match = payload.match;

          if (!state.match || (previousCode && state.match.code !== previousCode)) {
            resetMatchInteractionState();
          } else {
            pruneInteractionState();
          }
        }
      }

      async function runAction(message, task) {
        if (message) {
          setStatus(message);
        }

        try {
          const payload = await task();
          applyPayload(payload || {});
          render();
          setStatus(readyStatus());
          return payload;
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "发生未知错误");
          return null;
        }
      }

      function createStepper(value, onCommit, minimum, maximum, options = {}) {
        const wrapper = make("div", { className: "stepper-row" + (options.pending ? " pending" : "") });
        const minus = make("button", { text: "-" });
        const input = make("input", {
          type: "number",
          className: "number-input",
          value,
          min: minimum,
          max: maximum,
          inputMode: "numeric"
        });
        const plus = make("button", { text: "+" });
        const disabled = Boolean(options.disabled);

        minus.disabled = disabled;
        plus.disabled = disabled;
        input.disabled = disabled;

        minus.addEventListener("click", () => {
          const next = Math.max(minimum, Number(input.value || value) - 1);
          input.value = String(next);
          onCommit(next);
        });

        plus.addEventListener("click", () => {
          const next = Math.min(maximum, Number(input.value || value) + 1);
          input.value = String(next);
          onCommit(next);
        });

        input.addEventListener("change", () => {
          const raw = Number(input.value);
          const next = Number.isFinite(raw) ? Math.min(maximum, Math.max(minimum, Math.round(raw))) : value;
          input.value = String(next);
          onCommit(next);
        });

        wrapper.append(minus, input, plus);
        return wrapper;
      }

      async function commitTargetWins(value) {
        if (!state.match || state.targetWinsPending || state.match.targetWins === value) {
          return;
        }

        state.targetWinsPending = true;
        render();

        try {
          await runAction("正在更新目标局数…", () => api("/api/matches/current/target-wins", {
            method: "POST",
            body: JSON.stringify({ value })
          }));
        } finally {
          state.targetWinsPending = false;
          render();
        }
      }

      async function flushWinnerUpdate(frameNumber, requestedSlot) {
        const key = winnerKey(frameNumber);
        let nextSlot = requestedSlot;

        while (true) {
          try {
            const payload = await api("/api/matches/current/frames/" + frameNumber + "/winner", {
              method: "POST",
              body: JSON.stringify({ slot: nextSlot })
            });
            applyPayload(payload || {});
          } catch (error) {
            delete state.pendingWinners[key];
            render();
            setStatus(error instanceof Error ? error.message : "发生未知错误");
            return;
          }

          const pending = state.pendingWinners[key];

          if (!pending || !pending.hasQueuedSlot) {
            delete state.pendingWinners[key];
            render();
            setStatus(readyStatus());
            return;
          }

          nextSlot = pending.queuedSlot;
          pending.hasQueuedSlot = false;

          const frame = getFrame(frameNumber);

          if (!frame || frame.winnerSlot === nextSlot) {
            delete state.pendingWinners[key];
            render();
            setStatus(readyStatus());
            return;
          }

          pending.optimisticSlot = nextSlot;
          render();
        }
      }

      function queueWinnerUpdate(frameNumber, slot) {
        const frame = getFrame(frameNumber);

        if (!frame) {
          return;
        }

        const key = winnerKey(frameNumber);
        const pending = state.pendingWinners[key];

        if (pending) {
          pending.optimisticSlot = slot;
          pending.queuedSlot = slot;
          pending.hasQueuedSlot = true;
          render();
          return;
        }

        if (frame.winnerSlot === slot) {
          return;
        }

        state.pendingWinners[key] = {
          optimisticSlot: slot,
          queuedSlot: slot,
          hasQueuedSlot: false,
        };
        render();
        void flushWinnerUpdate(frameNumber, slot);
      }

      async function flushFoulUpdate(frameNumber, slot, requestedValue) {
        const key = foulKey(frameNumber, slot);
        let nextValue = requestedValue;

        while (true) {
          try {
            const payload = await api("/api/matches/current/frames/" + frameNumber + "/fouls", {
              method: "POST",
              body: JSON.stringify({ slot, value: nextValue })
            });
            applyPayload(payload || {});
          } catch (error) {
            delete state.pendingFouls[key];
            render();
            setStatus(error instanceof Error ? error.message : "发生未知错误");
            return;
          }

          const pending = state.pendingFouls[key];

          if (!pending || !pending.hasQueuedValue) {
            delete state.pendingFouls[key];
            render();
            setStatus(readyStatus());
            return;
          }

          nextValue = pending.queuedValue;
          pending.hasQueuedValue = false;

          const frame = getFrame(frameNumber);
          const currentValue = frame ? (slot === 1 ? frame.player1Fouls : frame.player2Fouls) : null;

          if (currentValue === nextValue) {
            delete state.pendingFouls[key];
            render();
            setStatus(readyStatus());
            return;
          }

          pending.optimisticValue = nextValue;
        }
      }

      function queueFoulUpdate(frameNumber, slot, value) {
        const frame = getFrame(frameNumber);

        if (!frame) {
          return;
        }

        const key = foulKey(frameNumber, slot);
        const currentValue = slot === 1 ? frame.player1Fouls : frame.player2Fouls;
        const pending = state.pendingFouls[key];

        if (pending) {
          pending.optimisticValue = value;
          pending.queuedValue = value;
          pending.hasQueuedValue = true;
          return;
        }

        if (currentValue === value) {
          return;
        }

        state.pendingFouls[key] = {
          optimisticValue: value,
          queuedValue: value,
          hasQueuedValue: false,
        };
        render();
        void flushFoulUpdate(frameNumber, slot, value);
      }

      function renderLobby() {
        shell.replaceChildren();
        const container = make("div", { className: "lobby-grid" });

        const intro = make("div", { className: "stack" });
        intro.append(
          make("h2", { text: state.user ? "你好，" + state.user.name : "开始一场新比赛" }),
          make("p", { text: "同一时间一个名字只能在一场比赛里。创建后把比赛编号发给另一位玩家即可。" })
        );

        const nameField = make("label", { className: "field" });
        nameField.append(
          make("span", { text: "你的名字" }),
          make("input", {
            placeholder: "例如：小王",
            value: state.user ? state.user.name : ""
          })
        );
        const nameInput = nameField.querySelector("input");
        nameInput.name = "player-name";
        nameInput.autocomplete = "nickname";

        const createButton = make("button", { className: "primary", text: "开启新比赛" });
        createButton.addEventListener("click", () => {
          runAction("正在创建比赛…", () => api("/api/matches", {
            method: "POST",
            body: JSON.stringify({ name: nameInput.value })
          }));
        });

        const joinCard = make("div", { className: "frame-card" });
        joinCard.append(make("h2", { text: "加入已有比赛" }));
        const codeField = make("label", { className: "field" });
        codeField.append(
          make("span", { text: "比赛编号" }),
          make("input", {
            placeholder: "输入两位数或更多编号",
            inputMode: "numeric"
          })
        );
        const codeInput = codeField.querySelector("input");
        codeInput.name = "match-code";
        codeInput.autocomplete = "one-time-code";
        codeInput.setAttribute("autocapitalize", "off");
        codeInput.spellcheck = false;
        const joinButton = make("button", { className: "secondary", text: "加入比赛" });
        joinButton.addEventListener("click", () => {
          runAction("正在加入比赛…", () => api("/api/matches/join", {
            method: "POST",
            body: JSON.stringify({ name: nameInput.value, code: codeInput.value })
          }));
        });
        joinCard.append(codeField, joinButton);

        const adminCard = make("div", { className: "frame-card" });
        adminCard.append(
          make("h2", { text: "Admin 登录" }),
          make("p", { text: "如需管理功能，可在此登录。" })
        );
        const adminAutofillAnchor = make("input", { value: "admin" });
        adminAutofillAnchor.name = "username";
        adminAutofillAnchor.autocomplete = "username";
        adminAutofillAnchor.tabIndex = -1;
        adminAutofillAnchor.readOnly = true;
        adminAutofillAnchor.setAttribute("aria-hidden", "true");
        adminAutofillAnchor.style.position = "absolute";
        adminAutofillAnchor.style.inlineSize = "1px";
        adminAutofillAnchor.style.blockSize = "1px";
        adminAutofillAnchor.style.opacity = "0";
        adminAutofillAnchor.style.pointerEvents = "none";
        const adminPasswordField = make("label", { className: "field" });
        adminPasswordField.append(
          make("span", { text: "管理员密码" }),
          make("input", {
            type: "password",
            placeholder: "管理员密码"
          })
        );
        const adminPasswordInput = adminPasswordField.querySelector("input");
        adminPasswordInput.name = "admin-password";
        adminPasswordInput.autocomplete = "current-password";
        const adminLoginButton = make("button", { className: "ghost", text: "Admin 登录" });
        adminLoginButton.addEventListener("click", () => {
          runAction("正在登录管理员…", () => api("/api/admin/session", {
            method: "POST",
            body: JSON.stringify({ password: adminPasswordInput.value })
          }));
        });
        adminCard.append(adminAutofillAnchor, adminPasswordField, adminLoginButton);

        container.append(intro, nameField, createButton, joinCard, adminCard);
        shell.append(container);
      }

      function renderAdminHome() {
        shell.replaceChildren();
        const container = make("div", { className: "match-stack" });
        const card = make("div", { className: "frame-card" });
        card.append(
          make("h2", { text: "Admin 已登录" }),
          make("p", { text: "管理员功能尚在开发中。" })
        );
        const logoutButton = make("button", { className: "ghost", text: "退出 Admin" });
        logoutButton.addEventListener("click", () => {
          runAction("正在退出管理员…", async () => {
            await api("/api/session", { method: "DELETE" });
            return { user: null, match: null };
          });
        });
        card.append(logoutButton);
        container.append(card);
        shell.append(container);
      }

      function renderMatch() {
        shell.replaceChildren();
        const match = state.match;
        if (!match) return;

        const container = make("div", { className: "match-stack" });
        const header = make("div", { className: "match-header" });
        const titleBox = make("div", { className: "stack" });
        titleBox.append(
          make("h2", { text: "当前比赛" }),
          make("div", { className: "code", text: match.code })
        );
        const targetBox = make("div", { className: "muted", text: "先胜 " + match.targetWins + " 局" });
        header.append(titleBox, targetBox);
        container.append(header);

        const scoreGrid = make("div", { className: "score-grid" });
        match.players.forEach((player) => {
          const card = make("div", { className: "score-card" });
          const nameRow = make("div");
          nameRow.append(make("span", { text: player.name || ("空位 " + player.slot) }));
          if (player.isSelf) {
            nameRow.append(make("span", { className: "self-tag", text: "你" }));
          }
          card.append(nameRow, make("strong", { text: String(match.totalWins[player.slot]) }), make("p", { text: "总比分（只读）" }));
          scoreGrid.append(card);
        });
        container.append(scoreGrid);

        if (match.winnerMessage) {
          container.append(make("div", { className: "announcement", text: match.winnerMessage }));
        }

        if (match.players.some((player) => !player.occupied)) {
          container.append(make("div", { className: "empty-seat", text: "当前有空位，把比赛编号告诉另一位玩家即可继续。" }));
        }

        const targetCard = make("div", { className: "target-card" });
        if (state.targetWinsPending) {
          targetCard.classList.add("pending");
        }
        targetCard.append(make("h2", { text: "胜利所需局数" }));
        targetCard.append(createStepper(match.targetWins, (value) => {
          void commitTargetWins(value);
        }, 1, 99, { disabled: state.targetWinsPending, pending: state.targetWinsPending }));
        container.append(targetCard);

        const frameList = make("div", { className: "frame-list" });
        match.frames.forEach((frame) => {
          const winnerPending = Boolean(state.pendingWinners[winnerKey(frame.number)]);
          const displayedWinnerSlot = getDisplayedWinnerSlot(frame);
          const frameCard = make("div", { className: "frame-card" });
          const frameHead = make("div", { className: "frame-head" });
          frameHead.append(make("h3", { text: "第 " + frame.number + " 局" }));
          if (displayedWinnerSlot != null) {
            const clearButton = make("button", { className: "ghost clear-button", text: "清空胜负" });
            clearButton.disabled = winnerPending;
            clearButton.addEventListener("click", () => {
              queueWinnerUpdate(frame.number, null);
            });
            frameHead.append(clearButton);
          }
          frameCard.append(frameHead);

          const winnerRow = make("div", { className: "winner-row" + (winnerPending ? " pending" : "") });
          match.players.forEach((player) => {
            const button = make("button", {
              className: "win-button" + (displayedWinnerSlot === player.slot ? " active" : ""),
              text: (player.name || ("玩家" + player.slot)) + " · win"
            });
            button.disabled = winnerPending;
            button.addEventListener("click", () => {
              queueWinnerUpdate(frame.number, player.slot);
            });
            winnerRow.append(button);
          });
          frameCard.append(winnerRow);

          const foulGrid = make("div", { className: "foul-grid" });
          match.players.forEach((player) => {
            const foulPending = Boolean(state.pendingFouls[foulKey(frame.number, player.slot)]);
            const stepperCard = make("div", { className: "stepper" + (foulPending ? " pending" : "") });
            stepperCard.append(make("p", { text: (player.name || ("玩家" + player.slot)) + " 犯规" }));
            const value = getDisplayedFoulValue(frame, player.slot);
            stepperCard.append(createStepper(value, (next) => {
              queueFoulUpdate(frame.number, player.slot, next);
            }, 0, 99, { pending: foulPending }));
            foulGrid.append(stepperCard);
          });
          frameCard.append(foulGrid);
          frameList.append(frameCard);
        });
        container.append(frameList);

        const actions = make("div", { className: "button-row" });
        const leaveButton = make("button", { className: "danger", text: "退出当前比赛" });
        leaveButton.addEventListener("click", () => {
          if (!window.confirm("确定退出当前比赛吗？")) return;
          runAction("正在退出比赛…", () => api("/api/matches/current/leave", { method: "POST" }));
        });
        const resetButton = make("button", { className: "ghost", text: "重置当前比赛" });
        resetButton.addEventListener("click", () => {
          if (!window.confirm("确定重置当前比赛吗？比分和犯规都会清空。")) return;
          runAction("正在重置比赛…", () => api("/api/matches/current/reset", { method: "POST" }));
        });
        actions.append(leaveButton, resetButton);
        container.append(actions);
        shell.append(container);
      }

      function render() {
        if (state.user && state.user.isAdmin) {
          renderAdminHome();
        } else if (state.match) {
          renderMatch();
        } else {
          renderLobby();
        }
        syncRealtime();
      }

      async function loadSession() {
        const payload = await api("/api/session");
        applyPayload(payload);
        render();
        if (state.match) {
          setStatus("已恢复进行中的比赛。");
          return;
        }

        setStatus(state.user && state.user.isAdmin ? "已登录管理员账号。" : "准备开始新的比赛。");
      }

      const realtime = {
        socket: null,
        retryDelay: 1000,
        wantOpen: false,
        matchCode: null,
        reconnectTimer: null,
      };

      async function refreshFromRealtime() {
        try {
          const payload = await api("/api/session");
          applyPayload(payload);
          render();
          setStatus(readyStatus());
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "同步失败");
        }
      }

      function closeRealtime() {
        realtime.wantOpen = false;
        realtime.matchCode = null;
        if (realtime.reconnectTimer != null) {
          window.clearTimeout(realtime.reconnectTimer);
          realtime.reconnectTimer = null;
        }
        if (realtime.socket) {
          try { realtime.socket.close(1000, "leaving"); } catch (_e) {}
          realtime.socket = null;
        }
      }

      function scheduleReconnect() {
        if (!realtime.wantOpen || realtime.reconnectTimer != null) return;
        const delay = realtime.retryDelay;
        realtime.reconnectTimer = window.setTimeout(() => {
          realtime.reconnectTimer = null;
          openRealtime();
        }, delay);
        realtime.retryDelay = Math.min(delay * 2, 15000);
      }

      function openRealtime() {
        if (!realtime.wantOpen) return;
        if (realtime.socket && (realtime.socket.readyState === 0 || realtime.socket.readyState === 1)) return;

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = protocol + "//" + window.location.host + "/api/matches/current/socket";
        let socket;
        try {
          socket = new WebSocket(url);
        } catch (_e) {
          scheduleReconnect();
          return;
        }
        realtime.socket = socket;

        socket.addEventListener("open", () => {
          realtime.retryDelay = 1000;
        });

        socket.addEventListener("message", (event) => {
          let payload = null;
          try { payload = JSON.parse(event.data); } catch (_e) { return; }
          if (payload && payload.type === "match-updated") {
            void refreshFromRealtime();
          }
        });

        socket.addEventListener("close", () => {
          realtime.socket = null;
          if (realtime.wantOpen) scheduleReconnect();
        });

        socket.addEventListener("error", () => {
          try { socket.close(); } catch (_e) {}
        });
      }

      function syncRealtime() {
        const matchCode = state.match ? state.match.code : null;
        const isAdmin = state.user && state.user.isAdmin;

        if (!matchCode || isAdmin) {
          closeRealtime();
          return;
        }

        if (realtime.matchCode !== matchCode) {
          closeRealtime();
          realtime.matchCode = matchCode;
        }

        realtime.wantOpen = true;
        if (!realtime.socket) {
          openRealtime();
        }
      }

      loadSession().catch((error) => {
        renderLobby();
        setStatus(error instanceof Error ? error.message : "连接失败");
      });
    </script>
  </body>
</html>`;
}

app.get("/", (c) => c.html(renderHomePage()));

app.get("/health", (c) => c.json({ ok: true, projectName: PROJECT_NAME, workerName: PROJECT_NAME }));

app.get("/api/session", async (c) => {
  await cleanupStaleMatches(c);
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ user: null, match: null });
  }

  const context = await loadCurrentMatchContext(c, user);
  const matchState = context ? await loadMatchState(c, context.match.id, user.id) : null;
  return c.json({ user: serializeUser(user), match: matchState });
});

app.post("/api/admin/session", async (c) => {
  const currentUser = await getAuthenticatedUser(c);

  if (currentUser) {
    if (isAdminUser(currentUser)) {
      return c.json({ user: serializeUser(currentUser), match: null });
    }

    const currentContext = await loadCurrentMatchContext(c, currentUser);

    if (currentContext) {
      return c.json({ error: "请先退出当前比赛后再使用管理员登录" }, 409);
    }

    await clearSession(c);
  }

  const payload = await readJson<{ password?: unknown }>(c);
  const password = typeof payload?.password === "string" ? payload.password : "";

  if (!password) {
    return c.json({ error: "管理员密码必填" }, 400);
  }

  const adminUser = await loginAdmin(c, password);

  if (!adminUser) {
    return c.json({ error: "管理员密码错误" }, 401);
  }

  return c.json({ user: serializeUser(adminUser), match: null });
});

app.post("/api/matches", async (c) => {
  await cleanupStaleMatches(c);
  const payload = await readJson<{ name?: unknown }>(c);
  const name = normalizeName(payload?.name);

  if (!name) {
    return c.json({ error: `名字必填，且不能超过 ${MAX_NAME_LENGTH} 个字符` }, 400);
  }

  const currentUser = await getAuthenticatedUser(c);

  if (isAdminUser(currentUser)) {
    return adminMatchBlockedResponse(c);
  }

  const user = await upsertSessionUser(c, name);
  const existingContext = await loadCurrentMatchContext(c, user);

  if (existingContext) {
    return c.json({ error: "你已经在另一场比赛里了，请先退出当前比赛" }, 409);
  }

  const db = getDatabase(c);
  const now = new Date();
  const matchId = crypto.randomUUID();
  const code = await generateMatchCode(c);

  await db.insert(matches).values({
    id: matchId,
    code,
    targetWins: DEFAULT_TARGET_WINS,
    player1UserId: user.id,
    player1Name: name,
    player2UserId: null,
    player2Name: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(frames).values({
    matchId,
    frameNumber: 1,
    winnerSlot: null,
    player1Fouls: 0,
    player2Fouls: 0,
    createdAt: now,
    updatedAt: now,
  });

  await db
    .update(users)
    .set({
      name,
      currentMatchId: matchId,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));

  const matchState = await loadMatchState(c, matchId, user.id);
  return c.json({ user: serializeUser({ ...user, name, currentMatchId: matchId, updatedAt: now }), match: matchState }, 201);
});

app.post("/api/matches/join", async (c) => {
  await cleanupStaleMatches(c);
  const payload = await readJson<{ name?: unknown; code?: unknown }>(c);
  const name = normalizeName(payload?.name);
  const code = normalizeCode(payload?.code);

  if (!name) {
    return c.json({ error: `名字必填，且不能超过 ${MAX_NAME_LENGTH} 个字符` }, 400);
  }

  if (!code) {
    return c.json({ error: "比赛编号格式不正确" }, 400);
  }

  const currentUser = await getAuthenticatedUser(c);

  if (isAdminUser(currentUser)) {
    return adminMatchBlockedResponse(c);
  }

  const user = await upsertSessionUser(c, name);
  const existingContext = await loadCurrentMatchContext(c, user);

  if (existingContext) {
    if (existingContext.match.code === code) {
      const matchState = await loadMatchState(c, existingContext.match.id, user.id);
      return c.json({ user: serializeUser(user), match: matchState });
    }

    return c.json({ error: "你已经在另一场比赛里了，请先退出当前比赛" }, 409);
  }

  const db = getDatabase(c);
  const match = await db.select().from(matches).where(eq(matches.code, code)).get();

  if (!match) {
    return c.json({ error: "没有找到这个比赛编号" }, 404);
  }

  let updateValues: Partial<typeof matches.$inferInsert> | null = null;

  if (!match.player1UserId) {
    updateValues = { player1UserId: user.id, player1Name: name };
  } else if (!match.player2UserId) {
    updateValues = { player2UserId: user.id, player2Name: name };
  } else {
    return c.json({ error: "这场比赛已经满员了" }, 409);
  }

  const now = new Date();
  await db
    .update(matches)
    .set({
      ...updateValues,
      updatedAt: now,
    })
    .where(eq(matches.id, match.id));

  await db
    .update(users)
    .set({
      name,
      currentMatchId: match.id,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));

  const matchState = await loadMatchState(c, match.id, user.id);
  notifyMatchRoom(c, match.id);
  return c.json({ user: serializeUser({ ...user, name, currentMatchId: match.id, updatedAt: now }), match: matchState });
});

app.post("/api/matches/current/target-wins", async (c) => {
  const current = await ensureCurrentMatch(c);

  if (current.response) {
    return current.response;
  }

  const payload = await readJson<{ value?: unknown }>(c);
  const parsedValue = parseInteger(payload?.value);

  if (parsedValue == null) {
    return c.json({ error: "目标局数必须是整数" }, 400);
  }

  const nextTargetWins = clamp(parsedValue, 1, MAX_TARGET_WINS);
  const db = getDatabase(c);

  if (current.context!.match.targetWins === nextTargetWins) {
    return respondWithCurrentState(c, current.user!);
  }

  const now = new Date();

  await db
    .update(matches)
    .set({
      targetWins: nextTargetWins,
      updatedAt: now,
    })
    .where(eq(matches.id, current.context!.match.id));

  notifyMatchRoom(c, current.context!.match.id);
  return respondWithCurrentState(c, current.user!);
});

app.post("/api/matches/current/frames/:frameNumber/winner", async (c) => {
  const current = await ensureCurrentMatch(c);

  if (current.response) {
    return current.response;
  }

  const payload = await readJson<{ slot?: unknown }>(c);
  const frameNumber = Number(c.req.param("frameNumber"));

  if (!Number.isInteger(frameNumber) || frameNumber <= 0) {
    return c.json({ error: "局数不正确" }, 400);
  }

  const slot = payload?.slot === null ? null : parseInteger(payload?.slot);

  if (slot !== null && slot !== 1 && slot !== 2) {
    return c.json({ error: "胜利方必须是 1、2 或空值" }, 400);
  }

  const db = getDatabase(c);
  const frame = await db
    .select()
    .from(frames)
    .where(and(eq(frames.matchId, current.context!.match.id), eq(frames.frameNumber, frameNumber)))
    .get();

  if (!frame) {
    return c.json({ error: "没有找到这一局" }, 404);
  }

  if (frame.winnerSlot === slot) {
    return respondWithCurrentState(c, current.user!);
  }

  const now = new Date();
  await db
    .update(frames)
    .set({
      winnerSlot: slot,
      updatedAt: now,
    })
    .where(eq(frames.id, frame.id));

  await db
    .update(matches)
    .set({
      updatedAt: now,
    })
    .where(eq(matches.id, current.context!.match.id));

  notifyMatchRoom(c, current.context!.match.id);
  return respondWithCurrentState(c, current.user!);
});

app.post("/api/matches/current/frames/:frameNumber/fouls", async (c) => {
  const current = await ensureCurrentMatch(c);

  if (current.response) {
    return current.response;
  }

  const payload = await readJson<{ slot?: unknown; value?: unknown }>(c);
  const frameNumber = Number(c.req.param("frameNumber"));
  const slot = parseInteger(payload?.slot);
  const value = parseInteger(payload?.value);

  if (!Number.isInteger(frameNumber) || frameNumber <= 0) {
    return c.json({ error: "局数不正确" }, 400);
  }

  if (slot !== 1 && slot !== 2) {
    return c.json({ error: "犯规方必须是 1 或 2" }, 400);
  }

  if (value == null) {
    return c.json({ error: "犯规次数必须是整数" }, 400);
  }

  const nextValue = clamp(value, 0, MAX_FOULS);
  const db = getDatabase(c);
  const frame = await db
    .select()
    .from(frames)
    .where(and(eq(frames.matchId, current.context!.match.id), eq(frames.frameNumber, frameNumber)))
    .get();

  if (!frame) {
    return c.json({ error: "没有找到这一局" }, 404);
  }

  const currentValue = slot === 1 ? frame.player1Fouls : frame.player2Fouls;

  if (currentValue === nextValue) {
    return respondWithCurrentState(c, current.user!);
  }

  const now = new Date();
  await db
    .update(frames)
    .set({
      ...(slot === 1 ? { player1Fouls: nextValue } : { player2Fouls: nextValue }),
      updatedAt: now,
    })
    .where(eq(frames.id, frame.id));

  await db
    .update(matches)
    .set({
      updatedAt: now,
    })
    .where(eq(matches.id, current.context!.match.id));

  notifyMatchRoom(c, current.context!.match.id);
  return respondWithCurrentState(c, current.user!);
});

app.post("/api/matches/current/reset", async (c) => {
  const current = await ensureCurrentMatch(c);

  if (current.response) {
    return current.response;
  }

  const db = getDatabase(c);
  const now = new Date();

  await db.delete(frames).where(eq(frames.matchId, current.context!.match.id));
  await db.insert(frames).values({
    matchId: current.context!.match.id,
    frameNumber: 1,
    winnerSlot: null,
    player1Fouls: 0,
    player2Fouls: 0,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(matches)
    .set({
      targetWins: DEFAULT_TARGET_WINS,
      updatedAt: now,
    })
    .where(eq(matches.id, current.context!.match.id));

  notifyMatchRoom(c, current.context!.match.id);
  return respondWithCurrentState(c, current.user!);
});

app.post("/api/matches/current/leave", async (c) => {
  const current = await ensureCurrentMatch(c);

  if (current.response) {
    return current.response;
  }

  const db = getDatabase(c);
  const now = new Date();
  const updates = current.context!.slot === 1
    ? { player1UserId: null, player1Name: null, updatedAt: now }
    : { player2UserId: null, player2Name: null, updatedAt: now };

  await db.update(matches).set(updates).where(eq(matches.id, current.context!.match.id));
  await db
    .update(users)
    .set({
      currentMatchId: null,
      updatedAt: now,
    })
    .where(eq(users.id, current.user!.id));

  const updatedMatch = await db.select().from(matches).where(eq(matches.id, current.context!.match.id)).get();

  if (updatedMatch && !updatedMatch.player1UserId && !updatedMatch.player2UserId) {
    await db.delete(frames).where(eq(frames.matchId, updatedMatch.id));
    await db.delete(matches).where(eq(matches.id, updatedMatch.id));
  }

  notifyMatchRoom(c, current.context!.match.id);

  return c.json({
    user: serializeUser({ ...current.user!, currentMatchId: null, updatedAt: now }),
    match: null,
  });
});

app.delete("/api/session", async (c) => {
  await clearSession(c);
  return c.json({ ok: true });
});

app.get("/api/matches/current/socket", async (c) => {
  if (c.req.header("upgrade") !== "websocket") {
    return c.text("expected websocket", 426);
  }

  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: "需要先填写名字并进入比赛" }, 401);
  }

  if (isAdminUser(user)) {
    return adminMatchBlockedResponse(c);
  }

  const context = await loadCurrentMatchContext(c, user);

  if (!context) {
    return c.json({ error: "当前没有进行中的比赛" }, 404);
  }

  const stub = getMatchRoomStub(c, context.match.id);
  return stub.fetch(matchRoomConnectUrl(user.id, context.match.id), {
    headers: { Upgrade: "websocket" },
  });
});

export default app;

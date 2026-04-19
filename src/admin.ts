import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { frames, matches, matchHistory, users, type Frame, type Match } from "./db/schema";

type Database = ReturnType<typeof drizzle>;

type PlayerSlot = 1 | 2;

export type ArchivedMatchStatus = "completed" | "closed" | "expired";
export type AdminMatchStatus = "ongoing" | ArchivedMatchStatus;

export type AdminMatchSnapshot = {
  matchId: string;
  code: string;
  archiveVersion: number;
  status: AdminMatchStatus;
  targetWins: number;
  players: {
    1: string | null;
    2: string | null;
  };
  frames: Array<{
    number: number;
    breakerSlot: PlayerSlot | null;
    winnerSlot: PlayerSlot | null;
    player1Fouls: number;
    player2Fouls: number;
  }>;
  totalWins: {
    1: number;
    2: number;
  };
  winnerSlot: PlayerSlot | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

function isPlayerSlot(value: unknown): value is PlayerSlot {
  return value === 1 || value === 2;
}

function oppositeSlot(slot: PlayerSlot): PlayerSlot {
  return slot === 1 ? 2 : 1;
}

function hasPlayerInSlot(match: Match, slot: PlayerSlot) {
  return slot === 1 ? Boolean(match.player1UserId) : Boolean(match.player2UserId);
}

function resolveOpeningSlot(match: Match): PlayerSlot {
  if (isPlayerSlot(match.openingSlot) && hasPlayerInSlot(match, match.openingSlot)) {
    return match.openingSlot;
  }

  if (match.player1UserId) {
    return 1;
  }

  if (match.player2UserId) {
    return 2;
  }

  return isPlayerSlot(match.openingSlot) ? match.openingSlot : 1;
}

function resolveAvailableSlot(match: Match, preferredSlot: PlayerSlot | null) {
  if (preferredSlot && hasPlayerInSlot(match, preferredSlot)) {
    return preferredSlot;
  }

  if (preferredSlot) {
    const alternateSlot = oppositeSlot(preferredSlot);

    if (hasPlayerInSlot(match, alternateSlot)) {
      return alternateSlot;
    }
  }

  if (match.player1UserId) {
    return 1 as const;
  }

  if (match.player2UserId) {
    return 2 as const;
  }

  return isPlayerSlot(match.openingSlot) ? match.openingSlot : 1;
}

function resolveFrameBreakerSlot(match: Match, frame: Frame, previousBreakerSlot: PlayerSlot | null) {
  if (isPlayerSlot(frame.breakerSlot)) {
    return frame.breakerSlot;
  }

  const preferredSlot = previousBreakerSlot
    ? oppositeSlot(previousBreakerSlot)
    : resolveOpeningSlot(match);

  return resolveAvailableSlot(match, preferredSlot);
}

function resolveFrameBreakerSlots(match: Match, frameRows: Frame[]) {
  let previousBreakerSlot: PlayerSlot | null = null;

  return frameRows.map((frame) => {
    const breakerSlot = resolveFrameBreakerSlot(match, frame, previousBreakerSlot);
    previousBreakerSlot = breakerSlot;
    return breakerSlot;
  });
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

function serializeSnapshot(match: Match, frameRows: Frame[], status: AdminMatchStatus, archivedAt: Date | null) {
  const breakerSlots = resolveFrameBreakerSlots(match, frameRows);
  const totalWins = calculateTotalWins(frameRows);
  const winnerSlot = determineWinnerSlot(match, frameRows);

  return {
    matchId: match.id,
    code: match.code,
    archiveVersion: match.archiveVersion,
    status,
    targetWins: match.targetWins,
    players: {
      1: match.player1Name ?? null,
      2: match.player2Name ?? null,
    },
    frames: frameRows.map((frame, index) => ({
      number: frame.frameNumber,
      breakerSlot: breakerSlots[index] ?? null,
      winnerSlot: frame.winnerSlot === 1 || frame.winnerSlot === 2 ? frame.winnerSlot : null,
      player1Fouls: frame.player1Fouls,
      player2Fouls: frame.player2Fouls,
    })),
    totalWins,
    winnerSlot,
    createdAt: match.createdAt.toISOString(),
    updatedAt: match.updatedAt.toISOString(),
    archivedAt: archivedAt ? archivedAt.toISOString() : null,
  } satisfies AdminMatchSnapshot;
}

function parseSnapshot(value: string): AdminMatchSnapshot | null {
  try {
    const parsed = JSON.parse(value) as AdminMatchSnapshot;

    if (!parsed || typeof parsed !== "object" || typeof parsed.matchId !== "string" || typeof parsed.code !== "string") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function syncArchivedMatch(
  db: Database,
  match: Match,
  frameRows: Frame[],
  fallbackStatus: ArchivedMatchStatus,
  archivedAt = new Date(),
) {
  const status = determineWinnerSlot(match, frameRows) ? "completed" : fallbackStatus;
  const snapshot = serializeSnapshot(match, frameRows, status, archivedAt);
  const values = {
    matchId: match.id,
    archiveVersion: match.archiveVersion,
    code: match.code,
    status,
    winnerSlot: snapshot.winnerSlot,
    targetWins: match.targetWins,
    player1Name: snapshot.players[1],
    player2Name: snapshot.players[2],
    player1Wins: snapshot.totalWins[1],
    player2Wins: snapshot.totalWins[2],
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    archivedAt,
    snapshot: JSON.stringify(snapshot),
  };

  const existing = await db
    .select({ id: matchHistory.id })
    .from(matchHistory)
    .where(and(eq(matchHistory.matchId, match.id), eq(matchHistory.archiveVersion, match.archiveVersion)))
    .get();

  if (existing) {
    await db.update(matchHistory).set(values).where(eq(matchHistory.id, existing.id));
  } else {
    await db.insert(matchHistory).values(values);
  }

  return snapshot;
}

export async function deleteArchivedMatch(db: Database, matchId: string, archiveVersion: number) {
  await db
    .delete(matchHistory)
    .where(and(eq(matchHistory.matchId, matchId), eq(matchHistory.archiveVersion, archiveVersion)));
}

export async function deleteArchivedMatchById(database: D1Database, matchId: string, archiveVersion: number) {
  const db = drizzle(database);
  const existing = await db
    .select({ id: matchHistory.id })
    .from(matchHistory)
    .where(and(eq(matchHistory.matchId, matchId), eq(matchHistory.archiveVersion, archiveVersion)))
    .get();

  if (!existing) {
    return false;
  }

  await deleteArchivedMatch(db, matchId, archiveVersion);
  return true;
}

export async function forceEndActiveMatch(database: D1Database, matchId: string) {
  const db = drizzle(database);
  const match = await db.select().from(matches).where(eq(matches.id, matchId)).get();

  if (!match) {
    return false;
  }

  const frameRows = await db
    .select()
    .from(frames)
    .where(eq(frames.matchId, matchId))
    .orderBy(asc(frames.frameNumber))
    .all();

  const now = new Date();
  await syncArchivedMatch(db, match, frameRows, "closed", now);

  // Detach any users that referenced this match, then delete frames + match.
  await db
    .update(users)
    .set({ currentMatchId: null, updatedAt: now })
    .where(eq(users.currentMatchId, matchId));

  await db.delete(frames).where(eq(frames.matchId, matchId));
  await db.delete(matches).where(eq(matches.id, matchId));
  return true;
}

async function seedMockHistoryIfEmpty(db: Database) {
  const existing = await db.select({ id: matchHistory.id }).from(matchHistory).limit(1).all();

  if (existing.length > 0) {
    return;
  }

  const liveExisting = await db.select({ id: matches.id }).from(matches).limit(1).all();

  if (liveExisting.length > 0) {
    return;
  }

  const baseTime = Date.now() - 1000 * 60 * 60 * 24 * 3;
  const samples: Array<{
    code: string;
    status: ArchivedMatchStatus;
    targetWins: number;
    p1: string;
    p2: string | null;
    frames: Array<{ breakerSlot: PlayerSlot; winnerSlot: PlayerSlot | null; player1Fouls: number; player2Fouls: number }>;
    minutesAgo: number;
  }> = [
    {
      code: "10",
      status: "completed",
      targetWins: 3,
      p1: "Alice",
      p2: "Bob",
      minutesAgo: 60 * 24,
      frames: [
        { breakerSlot: 1, winnerSlot: 1, player1Fouls: 0, player2Fouls: 1 },
        { breakerSlot: 2, winnerSlot: 2, player1Fouls: 1, player2Fouls: 0 },
        { breakerSlot: 1, winnerSlot: 1, player1Fouls: 0, player2Fouls: 0 },
        { breakerSlot: 2, winnerSlot: 1, player1Fouls: 0, player2Fouls: 2 },
      ],
    },
    {
      code: "27",
      status: "completed",
      targetWins: 2,
      p1: "Carol",
      p2: "Dave",
      minutesAgo: 60 * 12,
      frames: [
        { breakerSlot: 1, winnerSlot: 2, player1Fouls: 0, player2Fouls: 0 },
        { breakerSlot: 2, winnerSlot: 2, player1Fouls: 1, player2Fouls: 0 },
      ],
    },
    {
      code: "42",
      status: "closed",
      targetWins: 5,
      p1: "Solo",
      p2: null,
      minutesAgo: 60 * 2,
      frames: [
        { breakerSlot: 1, winnerSlot: 1, player1Fouls: 0, player2Fouls: 0 },
      ],
    },
  ];

  for (const sample of samples) {
    const archivedAt = new Date(baseTime + (3 - sample.minutesAgo / (60 * 24)) * 1000);
    const createdAt = new Date(archivedAt.getTime() - 1000 * 60 * 30);
    const updatedAt = archivedAt;
    const matchId = "mock-" + sample.code;

    let player1Wins = 0;
    let player2Wins = 0;
    for (const f of sample.frames) {
      if (f.winnerSlot === 1) player1Wins += 1;
      if (f.winnerSlot === 2) player2Wins += 1;
    }
    const winnerSlot = player1Wins >= sample.targetWins ? 1 : player2Wins >= sample.targetWins ? 2 : null;

    const snapshot: AdminMatchSnapshot = {
      matchId,
      code: sample.code,
      archiveVersion: 1,
      status: sample.status,
      targetWins: sample.targetWins,
      players: { 1: sample.p1, 2: sample.p2 },
      frames: sample.frames.map((f, index) => ({
        number: index + 1,
        breakerSlot: f.breakerSlot,
        winnerSlot: f.winnerSlot,
        player1Fouls: f.player1Fouls,
        player2Fouls: f.player2Fouls,
      })),
      totalWins: { 1: player1Wins, 2: player2Wins },
      winnerSlot,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      archivedAt: archivedAt.toISOString(),
    };

    await db.insert(matchHistory).values({
      matchId,
      archiveVersion: 1,
      code: sample.code,
      status: sample.status,
      winnerSlot,
      targetWins: sample.targetWins,
      player1Name: sample.p1,
      player2Name: sample.p2,
      player1Wins,
      player2Wins,
      createdAt,
      updatedAt,
      archivedAt,
      snapshot: JSON.stringify(snapshot),
    });
  }
}

export async function loadAdminDashboard(database: D1Database) {
  const db = drizzle(database);
  await seedMockHistoryIfEmpty(db);

  const liveMatches = await db.select().from(matches).orderBy(desc(matches.updatedAt)).all();
  const liveMatchIds = liveMatches.map((match) => match.id);
  const liveFrames = liveMatchIds.length > 0
    ? await db.select().from(frames).where(inArray(frames.matchId, liveMatchIds)).orderBy(asc(frames.frameNumber)).all()
    : [];

  const framesByMatchId = new Map<string, Frame[]>();

  for (const frame of liveFrames) {
    const bucket = framesByMatchId.get(frame.matchId) ?? [];
    bucket.push(frame);
    framesByMatchId.set(frame.matchId, bucket);
  }

  const ongoingMatches = liveMatches
    .map((match) => serializeSnapshot(match, framesByMatchId.get(match.id) ?? [], "ongoing", null))
    .filter((match) => match.winnerSlot == null);

  const historyRows = await db.select().from(matchHistory).orderBy(desc(matchHistory.archivedAt)).all();
  const historyMatches = historyRows
    .map((row) => parseSnapshot(row.snapshot))
    .filter((row): row is AdminMatchSnapshot => Boolean(row));

  return {
    ongoingMatches,
    historyMatches,
  };
}

export function renderAdminPage(options: {
  locale: string;
  messages: Record<string, string>;
}) {
  const { locale, messages } = options;
  const serializedMessages = JSON.stringify(messages).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${messages.adminTitle}</title>
    <style>
      :root {
        --bg: #0f172a;
        --panel: rgba(15, 23, 42, 0.88);
        --panel-strong: #111827;
        --line: rgba(148, 163, 184, 0.22);
        --text: #f8fafc;
        --muted: #94a3b8;
        --accent: #22c55e;
        --success: #22c55e;
        --warning: #f59e0b;
        --danger: #ef4444;
        --button: #334155;
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        background: radial-gradient(circle at top, #1e293b, var(--bg) 48%);
      }
      .page {
        width: min(1100px, calc(100vw - 16px));
        margin: 0 auto;
        padding: 14px 0 36px;
        display: grid;
        gap: 14px;
      }
      .topbar {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        padding: 10px 14px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--panel);
      }
      .topbar h1 {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 700;
        margin-right: auto;
      }
      .lang-toggle {
        display: inline-flex;
        border: 1px solid var(--line);
        border-radius: 999px;
        overflow: hidden;
      }
      .lang-toggle button {
        background: transparent;
        color: var(--muted);
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 600;
        border: 0;
        cursor: pointer;
      }
      .lang-toggle button.active {
        background: rgba(34, 197, 94, 0.18);
        color: #dcfce7;
      }
      .topbar button.action {
        padding: 6px 12px;
        font-size: 13px;
        font-weight: 700;
        border: 0;
        border-radius: 10px;
        cursor: pointer;
        background: var(--button);
        color: var(--text);
      }
      .topbar button.action.primary { background: var(--accent); color: #052e16; }
      .topbar button.action.danger { background: var(--danger); color: #fff; }
      .topbar button:disabled { opacity: 0.6; cursor: wait; }
      .status {
        font-size: 12px;
        color: var(--muted);
        padding: 0 4px;
      }
      .status.completed { color: var(--success); }
      .status.closed { color: var(--danger); }
      .panel {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--panel);
        padding: 14px;
        display: grid;
        gap: 10px;
      }
      .panel h2 {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 700;
        color: var(--text);
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .panel h2 .count {
        color: var(--muted);
        font-size: 0.8rem;
        font-weight: 500;
      }
      .empty {
        color: var(--muted);
        font-size: 13px;
        padding: 6px 2px;
      }
      .match {
        display: grid;
        gap: 6px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--panel-strong);
        padding: 10px 12px;
      }
      .match-head {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .match-head .code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 700;
        font-size: 0.95rem;
      }
      .match-head .tag {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--line);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .tag.ongoing { color: var(--accent); border-color: rgba(34, 197, 94, 0.4); }
      .tag.completed { color: var(--success); border-color: rgba(34, 197, 94, 0.4); }
      .tag.closed { color: var(--warning); border-color: rgba(245, 158, 11, 0.4); }
      .tag.expired { color: var(--warning); border-color: rgba(245, 158, 11, 0.4); }
      .match-head .spacer { flex: 1; }
      .match-head button.icon {
        background: transparent;
        color: var(--muted);
        padding: 4px 8px;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid var(--line);
        border-radius: 8px;
        cursor: pointer;
      }
      .match-head button.icon:hover { color: var(--text); }
      .match-head button.icon.danger { color: var(--danger); border-color: rgba(239, 68, 68, 0.4); }
      .match-head button:disabled { opacity: 0.5; cursor: wait; }
      .match pre {
        margin: 0;
        padding: 8px 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        line-height: 1.45;
        color: #e2e8f0;
        background: rgba(15, 23, 42, 0.6);
        border-radius: 8px;
        white-space: pre-wrap;
        word-break: break-word;
        user-select: text;
      }
      .login {
        max-width: 360px;
        margin: 24px auto 0;
        padding: 18px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--panel);
        display: grid;
        gap: 12px;
      }
      .login h2 { margin: 0; font-size: 1rem; }
      .login label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
      .login input {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px 12px;
        font: inherit;
        color: var(--text);
        background: rgba(15, 23, 42, 0.9);
      }
      .login button {
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        background: var(--accent);
        color: #052e16;
      }
      .login button:disabled { opacity: 0.6; cursor: wait; }
      @media (max-width: 720px) {
        .topbar h1 { font-size: 1rem; flex-basis: 100%; margin-right: 0; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <header class="topbar">
        <h1>${messages.adminTitle}</h1>
        <span id="status" class="status">${messages.adminLoadingDashboard}</span>
        <span class="lang-toggle" role="group" aria-label="${messages.languageLabel}">
          <button type="button" data-locale="zh-CN">${messages.languageNativeZh}</button>
          <button type="button" data-locale="en-US">${messages.languageNativeEn}</button>
        </span>
        <div id="topbar-actions" style="display:inline-flex;gap:6px;flex-wrap:wrap;"></div>
      </header>
      <section id="shell"></section>
    </main>
    <script>
      const messages = ${serializedMessages};
      const currentLocale = ${JSON.stringify(locale)};
      const state = { user: null, dashboard: null, pending: false };

      const shell = document.getElementById("shell");
      const statusNode = document.getElementById("status");
      const topbarActions = document.getElementById("topbar-actions");

      function t(key, params) {
        const template = messages[key] || key;
        if (!params) return template;
        return template.replace(/\\{(\\w+)\\}/g, (_, token) => {
          return Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : "{" + token + "}";
        });
      }

      function setStatus(text, tone) {
        statusNode.textContent = text;
        statusNode.className = "status" + (tone ? " " + tone : "");
      }

      function api(path, init = {}) {
        const headers = new Headers(init.headers || {});
        if (init.body && !headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
        return fetch(path, { credentials: "same-origin", ...init, headers })
          .then(async (response) => {
            const text = await response.text();
            const payload = text ? JSON.parse(text) : null;
            if (!response.ok) {
              const message = payload && payload.error ? payload.error : t("errorRequestFailed");
              throw new Error(message);
            }
            return payload;
          });
      }

      function formatDate(value) {
        if (!value) return "-";
        try {
          return new Intl.DateTimeFormat(currentLocale, {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit",
          }).format(new Date(value));
        } catch (_e) { return value; }
      }

      function statusLabel(status) {
        const map = {
          ongoing: t("adminStatusOngoing"),
          completed: t("adminStatusCompleted"),
          closed: t("adminStatusClosed"),
          expired: t("adminStatusExpired"),
        };
        return map[status] || status;
      }

      function pad(text, length) {
        text = String(text);
        return text.length >= length ? text : text + " ".repeat(length - text.length);
      }

      function buildMatchSummary(match) {
        const player1 = match.players[1] || t("emptySeat", { slot: "1" });
        const player2 = match.players[2] || t("emptySeat", { slot: "2" });
        const winnerLabel = match.winnerSlot == null
          ? t("adminNoWinner")
          : (match.winnerSlot === 1 ? player1 : player2);
        const lines = [];
        lines.push(t("adminCopyHeadCode") + " " + match.code + "  [" + statusLabel(match.status) + "]");
        lines.push(t("adminCopyPlayers") + " " + player1 + " (1) vs " + player2 + " (2)");
        lines.push(
          t("adminCopyScore") + " " + match.totalWins[1] + " : " + match.totalWins[2]
          + "   " + t("adminCopyTarget") + " " + match.targetWins
          + "   " + t("adminCopyWinner") + " " + winnerLabel,
        );
        lines.push(t("adminCopyStarted") + " " + formatDate(match.createdAt) + "   " +
          (match.archivedAt ? t("adminCopyArchived") + " " + formatDate(match.archivedAt)
                            : t("adminCopyUpdated") + " " + formatDate(match.updatedAt)));
        if (match.frames && match.frames.length > 0) {
          lines.push(t("adminCopyFramesHeader"));
          for (const frame of match.frames) {
            const breaker = frame.breakerSlot == null ? "-" : String(frame.breakerSlot);
            const winner = frame.winnerSlot == null ? "-" : String(frame.winnerSlot);
            lines.push(
              "  " + pad("F" + frame.number, 4)
              + " break=" + breaker
              + "  win=" + winner
              + "  fouls=" + frame.player1Fouls + "/" + frame.player2Fouls,
            );
          }
        }
        return lines.join("\\n");
      }

      async function copyToClipboard(text) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
          }
          setStatus(t("adminCopiedSuccess"), "completed");
        } catch (error) {
          setStatus(t("adminCopyFailed"), "closed");
        }
      }

      async function refreshDashboard(message) {
        if (!state.user || !state.user.isAdmin) return;
        state.pending = true;
        renderTopbarActions();
        if (message) setStatus(message);
        try {
          state.dashboard = await api("/api/admin/dashboard");
          setStatus(t("statusAdminLoggedIn"), "completed");
        } catch (error) {
          setStatus(error instanceof Error ? error.message : t("statusUnknownError"), "closed");
        } finally {
          state.pending = false;
          render();
        }
      }

      async function loginAdmin(password) {
        state.pending = true;
        renderTopbarActions();
        setStatus(t("adminLoginPending"));
        try {
          const payload = await api("/api/admin/session", {
            method: "POST",
            body: JSON.stringify({ password }),
          });
          state.user = payload.user;
          await refreshDashboard(t("adminLoadingDashboard"));
        } catch (error) {
          state.pending = false;
          renderTopbarActions();
          setStatus(error instanceof Error ? error.message : t("statusUnknownError"), "closed");
        }
      }

      async function logoutAdmin() {
        state.pending = true;
        renderTopbarActions();
        setStatus(t("adminLogoutPending"));
        try {
          await api("/api/session", { method: "DELETE" });
          state.user = null;
          state.dashboard = null;
          setStatus(t("statusAdminLoginPrompt"));
        } catch (error) {
          setStatus(error instanceof Error ? error.message : t("statusUnknownError"), "closed");
        } finally {
          state.pending = false;
          render();
        }
      }

      async function deleteHistory(matchId, archiveVersion) {
        if (!window.confirm(t("adminDeleteHistoryConfirm"))) return;
        try {
          setStatus(t("adminDeleteHistoryPending"));
          await api("/api/admin/history/" + encodeURIComponent(matchId) + "/" + archiveVersion, {
            method: "DELETE",
          });
          await refreshDashboard();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : t("statusUnknownError"), "closed");
        }
      }

      async function forceEndMatch(matchId) {
        if (!window.confirm(t("adminForceEndConfirm"))) return;
        try {
          setStatus(t("adminForceEndPending"));
          await api("/api/admin/matches/" + encodeURIComponent(matchId) + "/force-end", {
            method: "POST",
          });
          await refreshDashboard();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : t("statusUnknownError"), "closed");
        }
      }

      async function switchLocale(nextLocale) {
        if (nextLocale === currentLocale) return;
        try {
          setStatus(t("pageReloading"));
          await api("/api/locale", {
            method: "POST",
            body: JSON.stringify({ locale: nextLocale }),
          });
          window.location.reload();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : t("languageSwitchError"), "closed");
        }
      }

      function renderTopbarActions() {
        topbarActions.replaceChildren();
        const back = document.createElement("button");
        back.type = "button";
        back.className = "action";
        back.textContent = t("backHome");
        back.addEventListener("click", () => window.location.assign("/"));
        topbarActions.append(back);

        if (state.user && state.user.isAdmin) {
          const refresh = document.createElement("button");
          refresh.type = "button";
          refresh.className = "action";
          refresh.textContent = t("adminRefreshButton");
          refresh.disabled = state.pending;
          refresh.addEventListener("click", () => { void refreshDashboard(t("adminLoadingDashboard")); });

          const logout = document.createElement("button");
          logout.type = "button";
          logout.className = "action danger";
          logout.textContent = t("adminLogoutButton");
          logout.disabled = state.pending;
          logout.addEventListener("click", () => { void logoutAdmin(); });
          topbarActions.append(refresh, logout);
        }
      }

      function renderLogin() {
        const box = document.createElement("section");
        box.className = "login";
        const heading = document.createElement("h2");
        heading.textContent = t("adminLoginTitle");
        box.append(heading);

        const autofillAnchor = document.createElement("input");
        autofillAnchor.value = "admin";
        autofillAnchor.name = "username";
        autofillAnchor.autocomplete = "username";
        autofillAnchor.tabIndex = -1;
        autofillAnchor.readOnly = true;
        autofillAnchor.setAttribute("aria-hidden", "true");
        autofillAnchor.style.position = "absolute";
        autofillAnchor.style.inlineSize = "1px";
        autofillAnchor.style.blockSize = "1px";
        autofillAnchor.style.opacity = "0";
        autofillAnchor.style.pointerEvents = "none";

        const label = document.createElement("label");
        const span = document.createElement("span");
        span.textContent = t("adminPasswordLabel");
        const input = document.createElement("input");
        input.type = "password";
        input.placeholder = t("adminPasswordPlaceholder");
        input.name = "admin-password";
        input.autocomplete = "current-password";
        label.append(span, input);

        const submit = document.createElement("button");
        submit.type = "button";
        submit.textContent = t("adminLoginButton");
        submit.disabled = state.pending;
        submit.addEventListener("click", () => { void loginAdmin(input.value); });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void loginAdmin(input.value);
          }
        });

        box.append(autofillAnchor, label, submit);
        return box;
      }

      function renderMatchBlock(match, kind) {
        const wrapper = document.createElement("div");
        wrapper.className = "match";
        const head = document.createElement("div");
        head.className = "match-head";

        const code = document.createElement("span");
        code.className = "code";
        code.textContent = "#" + match.code;
        const tag = document.createElement("span");
        tag.className = "tag " + match.status;
        tag.textContent = statusLabel(match.status);
        const spacer = document.createElement("span");
        spacer.className = "spacer";

        head.append(code, tag, spacer);

        const summaryText = buildMatchSummary(match);

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "icon";
        copyBtn.textContent = t("adminCopySummary");
        copyBtn.addEventListener("click", () => { void copyToClipboard(summaryText); });
        head.append(copyBtn);

        if (kind === "ongoing") {
          const endBtn = document.createElement("button");
          endBtn.type = "button";
          endBtn.className = "icon danger";
          endBtn.textContent = t("adminForceEndButton");
          endBtn.addEventListener("click", () => { void forceEndMatch(match.matchId); });
          head.append(endBtn);
        } else {
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "icon danger";
          delBtn.textContent = t("adminDeleteHistoryButton");
          delBtn.addEventListener("click", () => { void deleteHistory(match.matchId, match.archiveVersion); });
          head.append(delBtn);
        }

        const pre = document.createElement("pre");
        pre.textContent = summaryText;

        wrapper.append(head, pre);
        return wrapper;
      }

      function renderPanel(titleKey, items, kind) {
        const panel = document.createElement("section");
        panel.className = "panel";
        const heading = document.createElement("h2");
        heading.textContent = t(titleKey);
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = "(" + (items ? items.length : 0) + ")";
        heading.append(count);
        panel.append(heading);

        if (!items || items.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = t(kind === "ongoing" ? "adminNoActiveMatches" : "adminNoHistoryMatches");
          panel.append(empty);
          return panel;
        }

        for (const item of items) {
          panel.append(renderMatchBlock(item, kind));
        }
        return panel;
      }

      function renderDashboard() {
        const wrap = document.createDocumentFragment();
        wrap.append(renderPanel("adminActiveMatchesTitle", state.dashboard ? state.dashboard.ongoingMatches : [], "ongoing"));
        wrap.append(renderPanel("adminHistoryMatchesTitle", state.dashboard ? state.dashboard.historyMatches : [], "history"));
        return wrap;
      }

      function render() {
        renderTopbarActions();
        shell.replaceChildren();
        if (!state.user || !state.user.isAdmin) {
          shell.append(renderLogin());
          return;
        }
        shell.append(renderDashboard());
      }

      async function loadSession() {
        try {
          const payload = await api("/api/session");
          state.user = payload.user;
          if (payload.user && payload.user.isAdmin) {
            await refreshDashboard(t("adminLoadingDashboard"));
            return;
          }
          state.dashboard = null;
          setStatus(t("statusAdminLoginPrompt"));
          render();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : t("statusUnknownError"), "closed");
          render();
        }
      }

      document.querySelectorAll("[data-locale]").forEach((button) => {
        const buttonLocale = button.getAttribute("data-locale");
        if (buttonLocale === currentLocale) {
          button.classList.add("active");
        }
        button.addEventListener("click", () => {
          if (buttonLocale) void switchLocale(buttonLocale);
        });
      });

      render();
      void loadSession();
    </script>
  </body>
</html>`;
}

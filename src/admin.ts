import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { frames, matches, matchHistory, type Frame, type Match } from "./db/schema";

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
  const preferredSlot = isPlayerSlot(frame.breakerSlot)
    ? frame.breakerSlot
    : previousBreakerSlot
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

export async function loadAdminDashboard(database: D1Database) {
  const db = drizzle(database);
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
        --bg: #f4ede3;
        --surface: rgba(255, 251, 246, 0.9);
        --surface-strong: #fff8f0;
        --line: rgba(82, 49, 19, 0.16);
        --ink: #2d1b0f;
        --muted: #725743;
        --accent: #b4471b;
        --accent-strong: #7b2608;
        --accent-soft: rgba(180, 71, 27, 0.12);
        --success: #2b6b3f;
        --warning: #915b00;
        --shadow: 0 24px 80px rgba(85, 46, 18, 0.12);
        font-family: Georgia, "Times New Roman", serif;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.75), transparent 34%),
          linear-gradient(180deg, #efe4d6 0%, #f8f2ea 48%, #ede2d3 100%);
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image: linear-gradient(rgba(61, 38, 20, 0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(61, 38, 20, 0.03) 1px, transparent 1px);
        background-size: 18px 18px;
        mask-image: radial-gradient(circle at center, black 55%, transparent 92%);
      }

      .page {
        position: relative;
        z-index: 1;
        width: min(1120px, calc(100vw - 24px));
        margin: 0 auto;
        padding: 24px 0 48px;
      }

      .hero {
        display: grid;
        gap: 18px;
        padding: 24px;
        border: 1px solid var(--line);
        border-radius: 28px;
        background: linear-gradient(135deg, rgba(255, 248, 240, 0.95), rgba(248, 239, 228, 0.88));
        box-shadow: var(--shadow);
      }

      .hero-top,
      .hero-actions,
      .toolbar,
      .button-row,
      .summary-grid,
      .match-meta,
      .match-heading {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
      }

      .eyebrow {
        letter-spacing: 0.18em;
        text-transform: uppercase;
        font-size: 12px;
        color: var(--accent-strong);
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 { font-size: clamp(32px, 8vw, 60px); line-height: 0.95; }
      h2 { font-size: 22px; }
      h3 { font-size: 18px; }

      .hero-copy {
        display: grid;
        gap: 10px;
      }

      .hero-copy p,
      .section-copy,
      .field span,
      .meta-label,
      .empty-state,
      .status-pill,
      .frame-list li {
        color: var(--muted);
      }

      .pill,
      .status-pill,
      .tag {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.62);
        font-size: 13px;
      }

      .shell,
      .section-grid {
        display: grid;
        gap: 18px;
      }

      .shell { margin-top: 22px; }

      .section-grid {
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      }

      .panel,
      .match-card {
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--surface);
        box-shadow: 0 18px 48px rgba(94, 53, 25, 0.1);
        backdrop-filter: blur(14px);
      }

      .panel {
        padding: 20px;
        display: grid;
        gap: 16px;
      }

      .match-card {
        padding: 18px;
        display: grid;
        gap: 14px;
      }

      .section-head {
        display: grid;
        gap: 6px;
      }

      .summary-grid {
        gap: 10px;
        align-items: stretch;
        justify-content: flex-start;
      }

      .summary-item {
        min-width: 140px;
        padding: 12px 14px;
        border-radius: 18px;
        background: var(--surface-strong);
        border: 1px solid rgba(123, 38, 8, 0.08);
      }

      .summary-item strong,
      .meta-value {
        display: block;
        margin-top: 6px;
        color: var(--ink);
      }

      .frame-list {
        display: grid;
        gap: 8px;
        padding-left: 20px;
        margin: 0;
      }

      .frame-list li {
        line-height: 1.5;
      }

      .field {
        display: grid;
        gap: 8px;
      }

      input {
        width: 100%;
        border: 1px solid rgba(77, 46, 20, 0.18);
        border-radius: 16px;
        padding: 14px 16px;
        font: inherit;
        color: var(--ink);
        background: rgba(255, 255, 255, 0.72);
      }

      button {
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        color: #fff9f2;
        background: linear-gradient(135deg, var(--accent), var(--accent-strong));
        box-shadow: 0 14px 32px rgba(123, 38, 8, 0.24);
      }

      button.secondary {
        color: var(--ink);
        background: rgba(255, 255, 255, 0.72);
        box-shadow: none;
        border: 1px solid var(--line);
      }

      button:disabled {
        cursor: wait;
        opacity: 0.65;
      }

      details {
        border-top: 1px solid rgba(77, 46, 20, 0.12);
        padding-top: 12px;
      }

      summary {
        cursor: pointer;
        font-weight: 700;
      }

      .tag.completed { color: var(--success); }
      .tag.closed,
      .tag.expired { color: var(--warning); }
      .tag.ongoing { color: var(--accent-strong); }

      .empty-state {
        padding: 18px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.58);
        border: 1px dashed rgba(77, 46, 20, 0.16);
      }

      @media (max-width: 720px) {
        .page {
          width: min(100vw - 14px, 100%);
          padding-top: 14px;
        }

        .hero,
        .panel,
        .match-card {
          border-radius: 22px;
        }

        .button-row button,
        .hero-actions button,
        .toolbar button {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <div class="hero-top">
          <div class="hero-copy">
            <span class="eyebrow">${messages.heroBadgeAdmin}</span>
            <h1>${messages.adminTitle}</h1>
            <p>${messages.adminDashboardHint}</p>
          </div>
          <div class="toolbar">
            <span class="pill">${messages.languageLabel}</span>
            <button class="secondary" type="button" data-locale="zh-CN">${messages.languageNativeZh}</button>
            <button class="secondary" type="button" data-locale="en-US">${messages.languageNativeEn}</button>
          </div>
        </div>
        <div class="hero-actions">
          <span id="status" class="status-pill">${messages.statusConnecting}</span>
          <div class="button-row" id="hero-actions"></div>
        </div>
      </section>
      <section id="shell" class="shell"></section>
    </main>
    <script>
      const messages = ${serializedMessages};
      const state = {
        user: null,
        dashboard: null,
        pending: false,
      };

      const shell = document.getElementById("shell");
      const statusNode = document.getElementById("status");
      const heroActions = document.getElementById("hero-actions");

      function t(key, params) {
        const template = messages[key] || key;

        if (!params) {
          return template;
        }

        return template.replace(/\{(\w+)\}/g, (_, token) => {
          return Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : "{" + token + "}";
        });
      }

      function setStatus(text, tone) {
        statusNode.textContent = text;
        statusNode.className = "status-pill" + (tone ? " " + tone : "");
      }

      function make(tag, options = {}) {
        const node = document.createElement(tag);
        if (options.className) node.className = options.className;
        if (options.text != null) node.textContent = options.text;
        if (options.html != null) node.innerHTML = options.html;
        if (options.type) node.type = options.type;
        if (options.placeholder != null) node.placeholder = options.placeholder;
        if (options.value != null) node.value = options.value;
        if (options.name) node.name = options.name;
        if (options.autocomplete) node.autocomplete = options.autocomplete;
        return node;
      }

      function api(path, init = {}) {
        const headers = new Headers(init.headers || {});
        if (init.body && !headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }

        return fetch(path, {
          credentials: "same-origin",
          ...init,
          headers,
        }).then(async (response) => {
          const text = await response.text();
          const payload = text ? JSON.parse(text) : null;

          if (!response.ok) {
            const message = payload && payload.error ? payload.error : t("errorRequestFailed");
            throw new Error(message);
          }

          return payload;
        });
      }

      function goTo(path) {
        window.location.assign(path);
      }

      function formatDate(value) {
        if (!value) {
          return "-";
        }

        try {
          return new Intl.DateTimeFormat(${JSON.stringify(locale)}, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(value));
        } catch {
          return value;
        }
      }

      function statusLabel(status) {
        const mapping = {
          ongoing: t("adminStatusOngoing"),
          completed: t("adminStatusCompleted"),
          closed: t("adminStatusClosed"),
          expired: t("adminStatusExpired"),
        };

        return mapping[status] || status;
      }

      async function refreshDashboard(statusText) {
        if (!state.user || !state.user.isAdmin) {
          return;
        }

        state.pending = true;
        renderHeroActions();
        setStatus(statusText || t("adminLoadingDashboard"));

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

      async function switchLocale(locale) {
        try {
          setStatus(t("pageReloading"));
          await api("/api/locale", {
            method: "POST",
            body: JSON.stringify({ locale }),
          });
          window.location.reload();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : t("languageSwitchError"), "closed");
        }
      }

      async function loginAdmin(password) {
        state.pending = true;
        renderHeroActions();
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
          renderHeroActions();
          setStatus(error instanceof Error ? error.message : t("statusUnknownError"), "closed");
        }
      }

      async function logoutAdmin() {
        state.pending = true;
        renderHeroActions();
        setStatus(t("adminLogoutPending"));

        try {
          await api("/api/session", { method: "DELETE" });
          state.user = null;
          state.dashboard = null;
          setStatus(t("statusAdminLoginPrompt"));
          render();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : t("statusUnknownError"), "closed");
        } finally {
          state.pending = false;
          renderHeroActions();
        }
      }

      function renderHeroActions() {
        heroActions.replaceChildren();

        const backButton = make("button", { className: "secondary", text: t("backHome"), type: "button" });
        backButton.addEventListener("click", () => goTo("/"));
        heroActions.append(backButton);

        if (state.user && state.user.isAdmin) {
          const refreshButton = make("button", { className: "secondary", text: t("adminRefreshButton"), type: "button" });
          refreshButton.disabled = state.pending;
          refreshButton.addEventListener("click", () => {
            void refreshDashboard(t("adminLoadingDashboard"));
          });

          const logoutButton = make("button", { text: t("adminLogoutButton"), type: "button" });
          logoutButton.disabled = state.pending;
          logoutButton.addEventListener("click", () => {
            void logoutAdmin();
          });
          heroActions.append(refreshButton, logoutButton);
          return;
        }

        const loginHint = make("span", { className: "pill", text: t("adminLoginHint") });
        heroActions.append(loginHint);
      }

      function renderLogin() {
        const panel = make("section", { className: "panel" });
        panel.append(
          make("div", { className: "section-head" }),
        );
        panel.firstChild.append(
          make("h2", { text: t("adminLoginTitle") }),
          make("p", { className: "section-copy", text: t("adminLoginHint") }),
        );

        const autofillAnchor = make("input", { value: "admin", name: "username", autocomplete: "username" });
        autofillAnchor.tabIndex = -1;
        autofillAnchor.readOnly = true;
        autofillAnchor.setAttribute("aria-hidden", "true");
        autofillAnchor.style.position = "absolute";
        autofillAnchor.style.inlineSize = "1px";
        autofillAnchor.style.blockSize = "1px";
        autofillAnchor.style.opacity = "0";
        autofillAnchor.style.pointerEvents = "none";

        const field = make("label", { className: "field" });
        field.append(
          make("span", { text: t("adminPasswordLabel") }),
          make("input", { type: "password", placeholder: t("adminPasswordPlaceholder"), name: "admin-password", autocomplete: "current-password" }),
        );
        const input = field.querySelector("input");

        const actions = make("div", { className: "button-row" });
        const submitButton = make("button", { text: t("adminLoginButton"), type: "button" });
        submitButton.disabled = state.pending;
        submitButton.addEventListener("click", () => {
          void loginAdmin(input.value);
        });
        field.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void loginAdmin(input.value);
          }
        });
        actions.append(submitButton);

        panel.append(autofillAnchor, field, actions);
        return panel;
      }

      function renderSummaryItem(label, value) {
        const item = make("div", { className: "summary-item" });
        item.append(
          make("span", { className: "meta-label", text: label }),
          make("strong", { text: value }),
        );
        return item;
      }

      function renderFrameList(match) {
        const list = make("ol", { className: "frame-list" });

        for (const frame of match.frames) {
          const line = make("li", {
            text: t("adminFrameSummary")
              .replace("{frame}", String(frame.number))
              .replace("{breaker}", frame.breakerSlot == null ? "-" : String(frame.breakerSlot))
              .replace("{winner}", frame.winnerSlot == null ? t("adminNoWinner") : String(frame.winnerSlot))
              .replace("{fouls1}", String(frame.player1Fouls))
              .replace("{fouls2}", String(frame.player2Fouls)),
          });
          list.append(line);
        }

        return list;
      }

      function renderMatchCard(match) {
        const card = make("article", { className: "match-card" });
        const heading = make("div", { className: "match-heading" });
        heading.append(
          make("div", { html: "<h3></h3><p class=\"section-copy\"></p>" }),
          make("span", { className: "tag " + match.status, text: statusLabel(match.status) }),
        );
        heading.querySelector("h3").textContent = t("adminMatchCodeValue", { code: match.code });
        heading.querySelector("p").textContent = t("adminPlayersValue", {
          player1: match.players[1] || t("emptySeat", { slot: "1" }),
          player2: match.players[2] || t("emptySeat", { slot: "2" }),
        });

        const summary = make("div", { className: "summary-grid" });
        summary.append(
          renderSummaryItem(t("adminTargetWinsLabel"), String(match.targetWins)),
          renderSummaryItem(t("adminScoreLabel"), match.totalWins[1] + " : " + match.totalWins[2]),
          renderSummaryItem(t("adminStartedAtLabel"), formatDate(match.createdAt)),
          renderSummaryItem(
            match.archivedAt ? t("adminArchivedAtLabel") : t("adminUpdatedAtLabel"),
            formatDate(match.archivedAt || match.updatedAt),
          ),
        );

        const details = make("details");
        if (match.status !== "ongoing") {
          details.open = true;
        }
        const summaryNode = document.createElement("summary");
        summaryNode.textContent = t("adminFramesTitle");
        details.append(summaryNode, renderFrameList(match));

        card.append(heading, summary, details);
        return card;
      }

      function renderDashboard() {
        const container = make("div", { className: "section-grid" });
        const ongoingPanel = make("section", { className: "panel" });
        ongoingPanel.append(
          make("div", { className: "section-head", html: "<h2></h2><p class=\"section-copy\"></p>" }),
        );
        ongoingPanel.querySelector("h2").textContent = t("adminActiveMatchesTitle");
        ongoingPanel.querySelector("p").textContent = t("adminActiveMatchesHint");

        const ongoingMatches = state.dashboard ? state.dashboard.ongoingMatches : [];
        if (!ongoingMatches || ongoingMatches.length === 0) {
          ongoingPanel.append(make("div", { className: "empty-state", text: t("adminNoActiveMatches") }));
        } else {
          for (const match of ongoingMatches) {
            ongoingPanel.append(renderMatchCard(match));
          }
        }

        const historyPanel = make("section", { className: "panel" });
        historyPanel.append(
          make("div", { className: "section-head", html: "<h2></h2><p class=\"section-copy\"></p>" }),
        );
        historyPanel.querySelector("h2").textContent = t("adminHistoryMatchesTitle");
        historyPanel.querySelector("p").textContent = t("adminHistoryMatchesHint");

        const historyMatches = state.dashboard ? state.dashboard.historyMatches : [];
        if (!historyMatches || historyMatches.length === 0) {
          historyPanel.append(make("div", { className: "empty-state", text: t("adminNoHistoryMatches") }));
        } else {
          for (const match of historyMatches) {
            historyPanel.append(renderMatchCard(match));
          }
        }

        container.append(ongoingPanel, historyPanel);
        return container;
      }

      function render() {
        renderHeroActions();
        shell.replaceChildren();

        if (!state.user || !state.user.isAdmin) {
          shell.append(renderLogin());
          return;
        }

        shell.append(renderDashboard());
      }

      document.querySelectorAll("[data-locale]").forEach((button) => {
        button.addEventListener("click", () => {
          const nextLocale = button.getAttribute("data-locale");
          if (nextLocale) {
            void switchLocale(nextLocale);
          }
        });
      });

      render();
      void loadSession();
    </script>
  </body>
</html>`;
}
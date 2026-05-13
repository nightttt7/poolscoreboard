import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createI18n } from "hono-i18n";

import { deleteArchivedMatch, deleteArchivedMatchById, forceEndActiveMatch, loadAdminDashboard, renderAdminPage, syncArchivedMatch } from "./admin";
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

type PlayerSlot = 1 | 2;

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
    breakerSlot: PlayerSlot;
    winnerSlot: PlayerSlot | null;
    player1Fouls: number;
    player2Fouls: number;
    startAt: string;
    endAt: string | null;
  }>;
  totalWins: {
    1: number;
    2: number;
  };
  winnerSlot: 1 | 2 | null;
  winnerMessage: string | null;
};

const LOCALE_COOKIE_NAME = "locale";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const DEFAULT_LOCALE = "zh-CN";
const PROJECT_NAME = "poolscoreboard";

const messages = {
  "zh-CN": {
    htmlLang: "zh-CN",
    appName: PROJECT_NAME,
    adminTitle: `${PROJECT_NAME} Admin`,
    heroBadgeLobby: "台球计分板",
    heroBadgeAdmin: "台球计分板 Admin",
    heroDescriptionAdmin: "",
    statusConnecting: "正在连接…",
    statusMatchSynced: "已同步比赛状态。",
    statusAdminLoggedIn: "已登录管理员账号。",
    statusAdminLoginPrompt: "请登录管理员账号。",
    statusLobbyReady: "准备开始新的比赛。",
    statusAdminUsePortal: "管理员账号请使用独立 Admin 页面。",
    statusMatchRestored: "已恢复进行中的比赛。",
    statusSyncFailed: "同步失败",
    statusConnectionFailed: "连接失败",
    statusUnknownError: "发生未知错误",
    errorRequestFailed: "请求失败",
    footerNote: PROJECT_NAME,
    languageLabel: "语言",
    languageNativeZh: "中文",
    languageNativeEn: "English",
    localeChanged: "已切换为中文。",
    pageReloading: "正在刷新页面…",
    languageSwitchError: "语言切换失败",
    errorLocaleInvalid: "语言选项不正确",
    adminLoginTitle: "Admin 登录",
    adminLoginHint: "独立管理员入口不会干扰首页的玩家输入。",
    adminPasswordLabel: "管理员密码",
    adminPasswordPlaceholder: "管理员密码",
    backHome: "返回首页",
    adminLoginButton: "Admin 登录",
    adminLoginPending: "正在登录管理员…",
    adminHomeTitle: "Admin 已登录",
    adminHomeHint: "查看进行中的比赛和历史归档。",
    adminLogoutButton: "退出 Admin",
    adminLogoutPending: "正在退出管理员…",
    adminDashboardHint: "查看正在进行的比赛，以及已经结束或关闭的历史对局。",
    adminRefreshButton: "刷新数据",
    adminLoadingDashboard: "正在加载管理数据…",
    adminActiveMatchesTitle: "进行中的比赛",
    adminActiveMatchesHint: "这里只显示尚未分出胜负的比赛。",
    adminNoActiveMatches: "当前没有进行中的比赛。",
    adminHistoryMatchesTitle: "历史对局",
    adminHistoryMatchesHint: "已获胜、被关闭或过期清理的对局都会保存在这里。",
    adminNoHistoryMatches: "还没有历史对局。",
    adminStatusOngoing: "进行中",
    adminStatusCompleted: "已完成",
    adminStatusClosed: "已关闭",
    adminStatusExpired: "已过期",
    adminMatchCodeValue: "比赛 #{code}",
    adminPlayersValue: "{player1} vs {player2}",
    adminTargetWinsLabel: "目标局数",
    adminScoreLabel: "当前比分",
    adminStartedAtLabel: "开始时间",
    adminUpdatedAtLabel: "最近更新",
    adminArchivedAtLabel: "归档时间",
    adminFramesTitle: "逐局详情",
    adminFrameSummary: "第 {frame} 局 · 开球 {breaker} · 胜方 {winner} · 犯规 {fouls1}/{fouls2}",
    adminNoWinner: "未定",
    adminForceEndButton: "强制结束",
    adminForceEndConfirm: "强制结束这场比赛？将归档为已关闭。",
    adminForceEndPending: "正在结束比赛…",
    adminDeleteHistoryButton: "删除",
    adminDeleteHistoryConfirm: "删除该历史记录？此操作无法撤销。",
    adminDeleteHistoryPending: "正在删除…",
    adminCopySummary: "复制",
    adminCopiedSuccess: "已复制到剪贴板。",
    adminCopyFailed: "复制失败",
    adminCopyHeadCode: "比赛编号:",
    adminCopyPlayers: "玩家:",
    adminCopyScore: "比分:",
    adminCopyTarget: "目标:",
    adminCopyWinner: "胜方:",
    adminCopyStarted: "开始:",
    adminCopyUpdated: "更新:",
    adminCopyArchived: "归档:",
    adminCopyFramesHeader: "局详情:",
    errorMatchNotFound: "找不到该比赛",
    errorHistoryNotFound: "找不到这条历史记录",
    lobbyCreateTitle: "开始一场新比赛",
    lobbyCreateHint: "创建后把比赛编号告知另一位玩家即可。",
    yourName: "你的名字",
    namePlaceholder: "例如：小王",
    createMatchButton: "开启新比赛",
    createMatchPending: "正在创建比赛…",
    joinTitle: "加入已有比赛",
    matchCodeLabel: "比赛编号",
    matchCodePlaceholder: "输入比赛编号",
    joinMatchButton: "加入比赛",
    joinMatchPending: "正在加入比赛…",
    adminPortalTitle: "Admin 入口",
    adminPortalHint: "当前已登录管理员账号，请在独立页面继续管理。",
    openAdminPage: "进入 Admin 页面",
    currentMatchTitle: "当前比赛",
    targetWinsSummary: "先胜 {count} 局",
    emptySeat: "空位 {slot}",
    selfTag: "你",
    totalScoreLabel: "总比分",
    emptySeatHint: "当前有空位，把比赛编号告诉另一位玩家即可继续。",
    targetWinsCardTitle: "胜利所需局数",
    updateTargetWinsPending: "正在更新目标局数…",
    frameTitle: "第 {frameNumber} 局",
    frameStartLabel: "开始: {time}",
    frameEndLabel: "结束: {time}",
    frameEndPending: "进行中",
    breakerLabel: "开球方: {name}",
    changeBreakerButton: "更换发球方",
    changeBreakerPending: "正在更换开球方…",
    clearWinner: "清空胜负",
    defaultPlayer: "玩家{slot}",
    winButton: "{name} · win",
    foulLabel: "{name} 犯规",
    leaveMatchButton: "退出当前比赛",
    leaveMatchConfirm: "确定退出当前比赛吗？",
    leaveMatchPending: "正在退出比赛…",
    resetMatchButton: "重置当前比赛",
    resetMatchConfirm: "确定重置当前比赛吗？比分和犯规都会清空。",
    resetMatchPending: "正在重置比赛…",
    websocketExpected: "expected websocket",
    errorNeedNameAndMatch: "需要先填写名字并进入比赛",
    errorNoCurrentMatch: "当前没有进行中的比赛",
    errorNeedExitBeforeAdminLogin: "请先退出当前比赛后再使用管理员登录",
    errorAdminRequired: "请先登录管理员账号",
    errorAdminForbidden: "当前会话没有管理员权限",
    errorAdminPasswordRequired: "管理员密码必填",
    errorAdminPasswordInvalid: "管理员密码错误",
    errorNameRequired: "名字必填，且不能超过 {max} 个字符",
    errorMatchCodeInvalid: "比赛编号格式不正确",
    errorAlreadyInOtherMatch: "你已经在另一场比赛里了，请先退出当前比赛",
    errorMatchCodeNotFound: "没有找到这个比赛编号",
    errorMatchFull: "这场比赛已经满员了",
    errorTargetWinsInteger: "目标局数必须是整数",
    errorFrameInvalid: "局数不正确",
    errorBreakerSlotInvalid: "开球方必须是 1 或 2",
    errorBreakerPlayerMissing: "开球方必须是当前在场玩家",
    errorWinnerSlotInvalid: "胜利方必须是 1、2 或空值",
    errorFrameNotFound: "没有找到这一局",
    errorFoulSlotInvalid: "犯规方必须是 1 或 2",
    errorFoulValueInteger: "犯规次数必须是整数",
    winnerMessage: "{winner}赢得了本场比赛，比分为 {player1} {score1} : {player2} {score2}",
  },
  "en-US": {
    htmlLang: "en-US",
    appName: PROJECT_NAME,
    adminTitle: `${PROJECT_NAME} Admin`,
    heroBadgeLobby: "Pool Scoreboard",
    heroBadgeAdmin: "Pool Scoreboard Admin",
    heroDescriptionAdmin: "",
    statusConnecting: "Connecting…",
    statusMatchSynced: "Match state is in sync.",
    statusAdminLoggedIn: "Admin is signed in.",
    statusAdminLoginPrompt: "Sign in as admin.",
    statusLobbyReady: "Ready to start a new match.",
    statusAdminUsePortal: "Admin accounts should use the dedicated admin page.",
    statusMatchRestored: "Restored the active match.",
    statusSyncFailed: "Sync failed",
    statusConnectionFailed: "Connection failed",
    statusUnknownError: "An unexpected error occurred",
    errorRequestFailed: "Request failed",
    footerNote: PROJECT_NAME,
    languageLabel: "Language",
    languageNativeZh: "中文",
    languageNativeEn: "English",
    localeChanged: "Switched to English.",
    pageReloading: "Reloading…",
    languageSwitchError: "Failed to switch language",
    errorLocaleInvalid: "Invalid locale selection",
    adminLoginTitle: "Admin Sign In",
    adminLoginHint: "The dedicated admin entry does not interfere with player inputs on the homepage.",
    adminPasswordLabel: "Admin password",
    adminPasswordPlaceholder: "Admin password",
    backHome: "Back Home",
    adminLoginButton: "Admin Sign In",
    adminLoginPending: "Signing in as admin…",
    adminHomeTitle: "Admin Signed In",
    adminHomeHint: "Review active matches and archived match history.",
    adminLogoutButton: "Sign Out Admin",
    adminLogoutPending: "Signing out admin…",
    adminDashboardHint: "Review live matches and the archived record of completed or closed sessions.",
    adminRefreshButton: "Refresh",
    adminLoadingDashboard: "Loading admin data…",
    adminActiveMatchesTitle: "Active Matches",
    adminActiveMatchesHint: "Only matches without a winner stay in this list.",
    adminNoActiveMatches: "There are no active matches right now.",
    adminHistoryMatchesTitle: "Match History",
    adminHistoryMatchesHint: "Completed, closed, and expired sessions are archived here.",
    adminNoHistoryMatches: "No archived matches yet.",
    adminStatusOngoing: "Ongoing",
    adminStatusCompleted: "Completed",
    adminStatusClosed: "Closed",
    adminStatusExpired: "Expired",
    adminMatchCodeValue: "Match #{code}",
    adminPlayersValue: "{player1} vs {player2}",
    adminTargetWinsLabel: "Target Frames",
    adminScoreLabel: "Score",
    adminStartedAtLabel: "Started",
    adminUpdatedAtLabel: "Last Updated",
    adminArchivedAtLabel: "Archived",
    adminFramesTitle: "Frame Details",
    adminFrameSummary: "Frame {frame} · Break {breaker} · Winner {winner} · Fouls {fouls1}/{fouls2}",
    adminNoWinner: "Pending",
    adminForceEndButton: "Force End",
    adminForceEndConfirm: "Force-end this match? It will be archived as closed.",
    adminForceEndPending: "Ending match…",
    adminDeleteHistoryButton: "Delete",
    adminDeleteHistoryConfirm: "Delete this history record? This action cannot be undone.",
    adminDeleteHistoryPending: "Deleting…",
    adminCopySummary: "Copy",
    adminCopiedSuccess: "Copied to clipboard.",
    adminCopyFailed: "Copy failed",
    adminCopyHeadCode: "Match:",
    adminCopyPlayers: "Players:",
    adminCopyScore: "Score:",
    adminCopyTarget: "Target:",
    adminCopyWinner: "Winner:",
    adminCopyStarted: "Started:",
    adminCopyUpdated: "Updated:",
    adminCopyArchived: "Archived:",
    adminCopyFramesHeader: "Frames:",
    errorMatchNotFound: "Match not found",
    errorHistoryNotFound: "History record not found",
    lobbyCreateTitle: "Start a New Match",
    lobbyCreateHint: "Create a match and share the code with the other player.",
    yourName: "Your name",
    namePlaceholder: "Example: Alex",
    createMatchButton: "Create Match",
    createMatchPending: "Creating match…",
    joinTitle: "Join an Existing Match",
    matchCodeLabel: "Match code",
    matchCodePlaceholder: "Enter the match code",
    joinMatchButton: "Join Match",
    joinMatchPending: "Joining match…",
    adminPortalTitle: "Admin Portal",
    adminPortalHint: "Admin is already signed in. Continue on the dedicated admin page.",
    openAdminPage: "Open Admin Page",
    currentMatchTitle: "Current Match",
    targetWinsSummary: "Race to {count}",
    emptySeat: "Open seat {slot}",
    selfTag: "You",
    totalScoreLabel: "Total score",
    emptySeatHint: "There is still an open seat. Share the match code with the other player to continue.",
    targetWinsCardTitle: "Frames Needed to Win",
    updateTargetWinsPending: "Updating target frames…",
    frameTitle: "Frame {frameNumber}",
    frameStartLabel: "Start: {time}",
    frameEndLabel: "End: {time}",
    frameEndPending: "In progress",
    breakerLabel: "Break by: {name}",
    changeBreakerButton: "Change breaker",
    changeBreakerPending: "Changing breaker…",
    clearWinner: "Clear Winner",
    defaultPlayer: "Player {slot}",
    winButton: "{name} · win",
    foulLabel: "{name} fouls",
    leaveMatchButton: "Leave Current Match",
    leaveMatchConfirm: "Leave the current match?",
    leaveMatchPending: "Leaving match…",
    resetMatchButton: "Reset Current Match",
    resetMatchConfirm: "Reset the current match? Scores and fouls will be cleared.",
    resetMatchPending: "Resetting match…",
    websocketExpected: "expected websocket",
    errorNeedNameAndMatch: "Enter your name and join a match first",
    errorNoCurrentMatch: "There is no active match",
    errorNeedExitBeforeAdminLogin: "Leave the current match before signing in as admin",
    errorAdminRequired: "Sign in as admin first",
    errorAdminForbidden: "This session does not have admin access",
    errorAdminPasswordRequired: "Admin password is required",
    errorAdminPasswordInvalid: "Admin password is incorrect",
    errorNameRequired: "Name is required and must be no longer than {max} characters",
    errorMatchCodeInvalid: "Match code format is invalid",
    errorAlreadyInOtherMatch: "You are already in another match. Leave it first",
    errorMatchCodeNotFound: "No match was found for that code",
    errorMatchFull: "This match is already full",
    errorTargetWinsInteger: "Target frames must be an integer",
    errorFrameInvalid: "Invalid frame number",
    errorBreakerSlotInvalid: "Breaker slot must be 1 or 2",
    errorBreakerPlayerMissing: "Breaker must be one of the active players",
    errorWinnerSlotInvalid: "Winner slot must be 1, 2, or null",
    errorFrameNotFound: "Frame not found",
    errorFoulSlotInvalid: "Foul slot must be 1 or 2",
    errorFoulValueInteger: "Foul count must be an integer",
    winnerMessage: "{winner} wins the match: {player1} {score1} : {player2} {score2}",
  },
} as const;

type Locale = keyof typeof messages;
type MessageKey = keyof typeof messages["zh-CN"];
type MessageDictionary = Record<MessageKey, string>;

const SUPPORTED_LOCALES = Object.keys(messages) as Locale[];

function normalizeLocale(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("zh")) {
    return "zh-CN" as const;
  }

  if (normalized.startsWith("en")) {
    return "en-US" as const;
  }

  return null;
}

function resolveLocale(c: AppContext) {
  const cookieLocale = normalizeLocale(getCookie(c, LOCALE_COOKIE_NAME));

  if (cookieLocale) {
    return cookieLocale;
  }

  const acceptLanguage = c.req.header("accept-language");

  if (acceptLanguage) {
    for (const segment of acceptLanguage.split(",")) {
      const candidate = normalizeLocale(segment.split(";")[0]);

      if (candidate) {
        return candidate;
      }
    }
  }

  return DEFAULT_LOCALE;
}

const { i18nMiddleware, getI18n } = createI18n<AppContext, typeof messages, Locale>({
  messages,
  defaultLocale: DEFAULT_LOCALE,
  getLocale: (c) => resolveLocale(c),
});

const app = new Hono<{ Bindings: Bindings }>();
app.use(i18nMiddleware);

type Translate = ReturnType<typeof getI18n>;

const DEFAULT_TARGET_WINS = 7;
const MAX_NAME_LENGTH = 24;
const MAX_TARGET_WINS = 99;
const MAX_FOULS = 99;
const MATCH_IDLE_TTL_MS = 1000 * 60 * 60 * 6;

function getDatabase(c: AppContext) {
  return drizzle(c.env.DB);
}

function setLocaleCookie(c: AppContext, locale: Locale) {
  setCookie(c, LOCALE_COOKIE_NAME, locale, {
    httpOnly: false,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
  });
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

function isPlayerSlot(value: unknown): value is PlayerSlot {
  return value === 1 || value === 2;
}

function oppositeSlot(slot: PlayerSlot): PlayerSlot {
  return slot === 1 ? 2 : 1;
}

function resolveOpeningSlot(match: Match): PlayerSlot {
  return isPlayerSlot(match.openingSlot) ? match.openingSlot : 1;
}

function resolveFrameBreakerSlot(match: Match, frame: Frame, previousBreakerSlot: PlayerSlot | null) {
  if (isPlayerSlot(frame.breakerSlot)) {
    return frame.breakerSlot;
  }

  return previousBreakerSlot
    ? oppositeSlot(previousBreakerSlot)
    : resolveOpeningSlot(match);
}

function resolveFrameBreakerSlots(match: Match, frameRows: Frame[]) {
  let previousBreakerSlot: PlayerSlot | null = null;

  return frameRows.map((frame) => {
    const breakerSlot = resolveFrameBreakerSlot(match, frame, previousBreakerSlot);
    previousBreakerSlot = breakerSlot;
    return breakerSlot;
  });
}

function playerName(t: Translate, match: Match, slot: 1 | 2) {
  const name = slot === 1 ? match.player1Name : match.player2Name;
  return name || t("defaultPlayer", { slot: String(slot) });
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
    .select()
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

  for (const match of staleMatches) {
    const frameRows = await db.select().from(frames).where(eq(frames.matchId, match.id)).orderBy(asc(frames.frameNumber)).all();
    await syncArchivedMatch(db, match, frameRows, "expired", now);
  }

  await db.delete(frames).where(inArray(frames.matchId, staleIds));
  await db.delete(matches).where(inArray(matches.id, staleIds));
}

async function normalizeFrames(c: AppContext, match: Match, timestamp = new Date()) {
  const db = getDatabase(c);
  const frameRows = await db.select().from(frames).where(eq(frames.matchId, match.id)).orderBy(asc(frames.frameNumber)).all();

  if (frameRows.length === 0) {
    await db.insert(frames).values({
      matchId: match.id,
      frameNumber: 1,
      breakerSlot: null,
      winnerSlot: null,
      player1Fouls: 0,
      player2Fouls: 0,
      endedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
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
    await db.insert(frames).values({
      matchId: match.id,
      frameNumber: lastFrame.frameNumber + 1,
      breakerSlot: null,
      winnerSlot: null,
      player1Fouls: 0,
      player2Fouls: 0,
      endedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

async function loadMatchState(c: AppContext, matchId: string, currentUserId: number | null) {
  const db = getDatabase(c);
  const t = getI18n(c);
  const match = await db.select().from(matches).where(eq(matches.id, matchId)).get();

  if (!match) {
    return null;
  }

  await normalizeFrames(c, match);
  const frameRows = await db.select().from(frames).where(eq(frames.matchId, match.id)).orderBy(asc(frames.frameNumber)).all();
  const breakerSlots = resolveFrameBreakerSlots(match, frameRows);
  const totalWins = calculateTotalWins(frameRows);
  const winnerSlot = determineWinnerSlot(match, frameRows);
  const winnerMessage = winnerSlot
    ? t("winnerMessage", {
      winner: playerName(t, match, winnerSlot),
      player1: playerName(t, match, 1),
      score1: String(totalWins[1]),
      player2: playerName(t, match, 2),
      score2: String(totalWins[2]),
    })
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
    frames: frameRows.map((frame, index) => ({
      number: frame.frameNumber,
      breakerSlot: breakerSlots[index]!,
      winnerSlot: frame.winnerSlot === 1 || frame.winnerSlot === 2 ? frame.winnerSlot : null,
      player1Fouls: frame.player1Fouls,
      player2Fouls: frame.player2Fouls,
      startAt: frame.createdAt.toISOString(),
      endAt: frame.winnerSlot === 1 || frame.winnerSlot === 2
        ? (frame.endedAt ?? frame.updatedAt).toISOString()
        : null,
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
  const t = getI18n(c);
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return {
      user: null,
      context: null,
      response: c.json({ error: t("errorNeedNameAndMatch") }, 401),
    };
  }

  const context = await loadCurrentMatchContext(c, user);

  if (!context) {
    return {
      user,
      context: null,
      response: c.json({ error: t("errorNoCurrentMatch") }, 404),
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

async function ensureAdminSession(c: AppContext) {
  const t = getI18n(c);
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return {
      user: null,
      response: c.json({ error: t("errorAdminRequired") }, 401),
    };
  }

  if (!isAdminUser(user)) {
    return {
      user,
      response: c.json({ error: t("errorAdminForbidden") }, 403),
    };
  }

  return {
    user,
    response: null,
  };
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

function renderHomePage(c: AppContext, pageMode: "lobby" | "admin" = "lobby") {
  const isAdminPage = pageMode === "admin";
  const locale = resolveLocale(c);
  const currentMessages = messages[locale] as MessageDictionary;
  const t = getI18n(c);
  const clientTranslationKeys: MessageKey[] = isAdminPage
    ? [
      "statusMatchSynced",
      "statusAdminLoggedIn",
      "statusAdminLoginPrompt",
      "statusUnknownError",
      "errorRequestFailed",
      "pageReloading",
      "languageSwitchError",
      "adminLoginTitle",
      "adminLoginHint",
      "adminPasswordLabel",
      "adminPasswordPlaceholder",
      "backHome",
      "adminLoginButton",
      "adminLoginPending",
      "adminHomeTitle",
      "adminHomeHint",
      "adminLogoutButton",
      "adminLogoutPending",
      "statusMatchRestored",
      "statusSyncFailed",
      "statusConnectionFailed",
    ]
    : [
      "statusMatchSynced",
      "statusAdminLoggedIn",
      "statusAdminUsePortal",
      "statusLobbyReady",
      "statusUnknownError",
      "errorRequestFailed",
      "pageReloading",
      "languageSwitchError",
      "defaultPlayer",
      "emptySeat",
      "lobbyCreateTitle",
      "lobbyCreateHint",
      "yourName",
      "namePlaceholder",
      "createMatchButton",
      "createMatchPending",
      "joinTitle",
      "matchCodeLabel",
      "matchCodePlaceholder",
      "joinMatchButton",
      "joinMatchPending",
      "adminPortalTitle",
      "adminPortalHint",
      "openAdminPage",
      "adminLogoutButton",
      "adminLogoutPending",
      "currentMatchTitle",
      "targetWinsSummary",
      "selfTag",
      "totalScoreLabel",
      "emptySeatHint",
      "targetWinsCardTitle",
      "updateTargetWinsPending",
      "frameTitle",
      "frameStartLabel",
      "frameEndLabel",
      "frameEndPending",
      "breakerLabel",
      "changeBreakerButton",
      "changeBreakerPending",
      "clearWinner",
      "winButton",
      "foulLabel",
      "leaveMatchButton",
      "leaveMatchConfirm",
      "leaveMatchPending",
      "resetMatchButton",
      "resetMatchConfirm",
      "resetMatchPending",
      "statusMatchRestored",
      "statusSyncFailed",
      "statusConnectionFailed",
    ];
  const clientTranslations = Object.fromEntries(
    clientTranslationKeys.map((key) => [key, currentMessages[key]]),
  );
  const pageTitle = isAdminPage ? t("adminTitle") : t("appName");
  const heroBadge = isAdminPage ? t("heroBadgeAdmin") : t("heroBadgeLobby");
  const heroDescription = isAdminPage ? t("heroDescriptionAdmin") : null;

  return `<!DOCTYPE html>
<html lang="${currentMessages.htmlLang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${pageTitle}</title>
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
      .hero-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        flex-wrap: wrap;
      }
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
      .locale-switch {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        padding: 6px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.56);
        border: 1px solid var(--line);
      }
      .locale-button {
        border: 1px solid transparent;
        border-radius: 999px;
        background: transparent;
        color: var(--muted);
        padding: 8px 12px;
        font-size: 0.85rem;
        font-weight: 700;
      }
      .locale-button.active {
        background: var(--accent-soft);
        border-color: rgba(34, 197, 94, 0.24);
        color: #dcfce7;
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
      .frame-times {
        display: flex;
        gap: 8px 14px;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 0.86rem;
      }
      .breaker-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
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
      .score-grid.sticky {
        position: sticky;
        top: 0;
        z-index: 10;
        background: rgba(15, 23, 42, 0.95);
        backdrop-filter: blur(8px);
        padding: 8px;
        margin: -8px;
        border-radius: 16px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
      }
    </style>
  </head>
  <body>
    <main class="stack">
      <section class="panel hero">
        <div class="hero-top">
          <h1 class="hero-title">${heroBadge}</h1>
          <div class="locale-switch" aria-label="${t("languageLabel")}">
            ${SUPPORTED_LOCALES.map((supportedLocale) => `
              <button
                type="button"
                class="locale-button${supportedLocale === locale ? " active" : ""}"
                data-locale="${supportedLocale}"
              >${supportedLocale === "zh-CN" ? t("languageNativeZh") : t("languageNativeEn")}</button>
            `).join("")}
          </div>
        </div>
        ${heroDescription ? `<p>${heroDescription}</p>` : ""}
      </section>
      <section class="panel">
        <div class="status" id="status">${t("statusConnecting")}</div>
      </section>
      <section class="panel" id="app-shell"></section>
      <p class="footer-note">${t("footerNote")}</p>
    </main>
    <script>
      const pageMode = ${JSON.stringify(pageMode)};
      const locale = ${JSON.stringify(locale)};
      const supportedLocales = ${JSON.stringify(SUPPORTED_LOCALES)};
      const translations = ${JSON.stringify(clientTranslations)};
      const shell = document.getElementById("app-shell");
      const statusNode = document.getElementById("status");
      const localeButtons = Array.from(document.querySelectorAll("[data-locale]"));
      const state = {
        user: null,
        match: null,
        targetWinsPending: false,
        pendingBreakers: {},
        pendingWinners: {},
        pendingFouls: {},
      };

      function setStatus(message) {
        statusNode.textContent = message;
      }

      function translate(key, params = {}) {
        const template = translations[key] || key;
        return String(template).replace(/\\{(\\w+)\\}/g, (_, name) => {
          const value = params[name];
          return value == null ? "" : String(value);
        });
      }

      function readyStatus() {
        if (state.match) {
          return translate("statusMatchSynced");
        }

        if (pageMode === "admin") {
          return state.user && state.user.isAdmin ? translate("statusAdminLoggedIn") : translate("statusAdminLoginPrompt");
        }

        return state.user && state.user.isAdmin ? translate("statusAdminLoggedIn") : translate("statusLobbyReady");
      }

      function resetMatchInteractionState() {
        state.targetWinsPending = false;
        state.pendingBreakers = {};
        state.pendingWinners = {};
        state.pendingFouls = {};
      }

      function getFrame(frameNumber) {
        return state.match ? state.match.frames.find((frame) => frame.number === frameNumber) || null : null;
      }

      function winnerKey(frameNumber) {
        return String(frameNumber);
      }

      function breakerKey(frameNumber) {
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

        for (const key of Object.keys(state.pendingBreakers)) {
          if (!activeFrames.has(key)) {
            delete state.pendingBreakers[key];
          }
        }

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

      function playerLabel(player) {
        return player.name || translate("defaultPlayer", { slot: player.slot });
      }

      function seatLabel(player) {
        return player.name || translate("emptySeat", { slot: player.slot });
      }

      function formatFrameTime(value) {
        if (!value) {
          return translate("frameEndPending");
        }

        return new Intl.DateTimeFormat(locale, {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        }).format(new Date(value));
      }

      function goTo(path) {
        window.location.href = path;
      }

      async function switchLocale(nextLocale) {
        if (!supportedLocales.includes(nextLocale) || nextLocale === locale) {
          return;
        }

        setStatus(translate("pageReloading"));

        try {
          await api("/api/locale", {
            method: "POST",
            body: JSON.stringify({ locale: nextLocale })
          });
          window.location.reload();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : translate("languageSwitchError"));
        }
      }

      function logoutSession(pendingMessage) {
        runAction(pendingMessage, async () => {
          await api("/api/session", { method: "DELETE" });
          return { user: null, match: null };
        });
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
          throw new Error(payload.error || translate("errorRequestFailed"));
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
          setStatus(error instanceof Error ? error.message : translate("statusUnknownError"));
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
          await runAction(translate("updateTargetWinsPending"), () => api("/api/matches/current/target-wins", {
            method: "POST",
            body: JSON.stringify({ value })
          }));
        } finally {
          state.targetWinsPending = false;
          render();
        }
      }

      async function commitBreaker(frameNumber, slot) {
        const key = breakerKey(frameNumber);

        if (state.pendingBreakers[key]) {
          return;
        }

        state.pendingBreakers[key] = true;
        render();

        try {
          await runAction(translate("changeBreakerPending"), () => api("/api/matches/current/frames/" + frameNumber + "/breaker", {
            method: "POST",
            body: JSON.stringify({ slot })
          }));
        } finally {
          delete state.pendingBreakers[key];
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
            setStatus(error instanceof Error ? error.message : translate("statusUnknownError"));
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
            setStatus(error instanceof Error ? error.message : translate("statusUnknownError"));
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

      localeButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const nextLocale = button.getAttribute("data-locale");
          if (nextLocale) {
            void switchLocale(nextLocale);
          }
        });
      });

${isAdminPage ? `
      function renderAdminLogin() {
        shell.replaceChildren();
        const container = make("div", { className: "match-stack" });
        const card = make("div", { className: "frame-card" });
        card.append(
          make("h2", { text: translate("adminLoginTitle") }),
          make("p", { text: translate("adminLoginHint") })
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
          make("span", { text: translate("adminPasswordLabel") }),
          make("input", {
            type: "password",
            placeholder: translate("adminPasswordPlaceholder")
          })
        );
        const adminPasswordInput = adminPasswordField.querySelector("input");
        adminPasswordInput.name = "admin-password";
        adminPasswordInput.autocomplete = "current-password";

        const actions = make("div", { className: "button-row" });
        const backButton = make("button", { className: "ghost", text: translate("backHome") });
        backButton.addEventListener("click", () => {
          goTo("/");
        });
        const adminLoginButton = make("button", { className: "primary", text: translate("adminLoginButton") });
        adminLoginButton.addEventListener("click", () => {
          runAction(translate("adminLoginPending"), () => api("/api/admin/session", {
            method: "POST",
            body: JSON.stringify({ password: adminPasswordInput.value })
          }));
        });
        actions.append(backButton, adminLoginButton);
        card.append(adminAutofillAnchor, adminPasswordField, actions);
        container.append(card);
        shell.append(container);
      }

      function renderAdminHome() {
        shell.replaceChildren();
        const container = make("div", { className: "match-stack" });
        const card = make("div", { className: "frame-card" });
        card.append(
          make("h2", { text: translate("adminHomeTitle") }),
          make("p", { text: translate("adminHomeHint") })
        );
        const actions = make("div", { className: "button-row" });
        const backButton = make("button", { className: "ghost", text: translate("backHome") });
        backButton.addEventListener("click", () => {
          goTo("/");
        });
        const logoutButton = make("button", { className: "ghost", text: translate("adminLogoutButton") });
        logoutButton.addEventListener("click", () => {
          logoutSession(translate("adminLogoutPending"));
        });
        actions.append(backButton, logoutButton);
        card.append(actions);
        container.append(card);
        shell.append(container);
      }

      function renderSignedOutView() {
        renderAdminLogin();
      }

      function renderSignedInAdminView() {
        renderAdminHome();
      }
` : `
      function renderLobby() {
        shell.replaceChildren();
        const container = make("div", { className: "lobby-grid" });

        const nameField = make("label", { className: "field" });
        nameField.append(
          make("span", { text: translate("yourName") }),
          make("input", {
            placeholder: translate("namePlaceholder"),
            value: state.user ? state.user.name : ""
          })
        );
        const nameInput = nameField.querySelector("input");
        nameInput.name = "player-name";
        nameInput.autocomplete = "nickname";

        const createButton = make("button", { className: "primary", text: translate("createMatchButton") });
        createButton.addEventListener("click", () => {
          runAction(translate("createMatchPending"), () => api("/api/matches", {
            method: "POST",
            body: JSON.stringify({ name: nameInput.value })
          }));
        });

        const createCard = make("div", { className: "frame-card" });
        createCard.append(
          make("h2", { text: translate("lobbyCreateTitle") }),
          make("p", { text: translate("lobbyCreateHint") }),
          createButton
        );

        const joinCard = make("div", { className: "frame-card" });
        joinCard.append(make("h2", { text: translate("joinTitle") }));
        const codeField = make("label", { className: "field" });
        codeField.append(
          make("span", { text: translate("matchCodeLabel") }),
          make("input", {
            placeholder: translate("matchCodePlaceholder"),
            inputMode: "numeric"
          })
        );
        const codeInput = codeField.querySelector("input");
        codeInput.name = "match-code";
        codeInput.autocomplete = "one-time-code";
        codeInput.setAttribute("autocapitalize", "off");
        codeInput.spellcheck = false;
        const joinButton = make("button", { className: "secondary", text: translate("joinMatchButton") });
        joinButton.addEventListener("click", () => {
          runAction(translate("joinMatchPending"), () => api("/api/matches/join", {
            method: "POST",
            body: JSON.stringify({ name: nameInput.value, code: codeInput.value })
          }));
        });
        joinCard.append(codeField, joinButton);

        container.append(nameField, createCard, joinCard);
        shell.append(container);
      }

      function renderAdminPortal() {
        shell.replaceChildren();
        const container = make("div", { className: "match-stack" });
        const card = make("div", { className: "frame-card" });
        card.append(
          make("h2", { text: translate("adminPortalTitle") }),
          make("p", { text: translate("adminPortalHint") })
        );
        const actions = make("div", { className: "button-row" });
        const openButton = make("button", { className: "primary", text: translate("openAdminPage") });
        openButton.addEventListener("click", () => {
          goTo("/admin");
        });
        const logoutButton = make("button", { className: "ghost", text: translate("adminLogoutButton") });
        logoutButton.addEventListener("click", () => {
          logoutSession(translate("adminLogoutPending"));
        });
        actions.append(openButton, logoutButton);
        card.append(actions);
        container.append(card);
        shell.append(container);
      }

      function renderSignedOutView() {
        renderLobby();
      }

      function renderSignedInAdminView() {
        renderLobby();
      }
`}

      function renderMatch() {
        shell.replaceChildren();
        const match = state.match;
        if (!match) return;

        const container = make("div", { className: "match-stack" });
        const header = make("div", { className: "match-header" });
        const titleBox = make("div", { className: "stack" });
        titleBox.append(
          make("h2", { text: translate("currentMatchTitle") }),
          make("div", { className: "code", text: match.code })
        );
        const targetBox = make("div", { className: "muted", text: translate("targetWinsSummary", { count: match.targetWins }) });
        header.append(titleBox, targetBox);
        container.append(header);

        const scoreGrid = make("div", { className: "score-grid sticky" });
        match.players.forEach((player) => {
          const card = make("div", { className: "score-card" });
          const nameRow = make("div");
          nameRow.append(make("span", { text: seatLabel(player) }));
          if (player.isSelf) {
            nameRow.append(make("span", { className: "self-tag", text: translate("selfTag") }));
          }
          const scoreValue = make("strong", { text: String(match.totalWins[player.slot]) });
          scoreValue.title = translate("totalScoreLabel");
          card.append(nameRow, scoreValue);
          scoreGrid.append(card);
        });
        container.append(scoreGrid);

        if (match.winnerMessage) {
          container.append(make("div", { className: "announcement", text: match.winnerMessage }));
        }

        if (match.players.some((player) => !player.occupied)) {
          container.append(make("div", { className: "empty-seat", text: translate("emptySeatHint") }));
        }

        const targetCard = make("div", { className: "target-card" });
        if (state.targetWinsPending) {
          targetCard.classList.add("pending");
        }
        targetCard.append(make("h2", { text: translate("targetWinsCardTitle") }));
        targetCard.append(createStepper(match.targetWins, (value) => {
          void commitTargetWins(value);
        }, 1, 99, { disabled: state.targetWinsPending, pending: state.targetWinsPending }));
        container.append(targetCard);

        const frameList = make("div", { className: "frame-list" });
        match.frames.forEach((frame) => {
          const breakerPending = Boolean(state.pendingBreakers[breakerKey(frame.number)]);
          const winnerPending = Boolean(state.pendingWinners[winnerKey(frame.number)]);
          const displayedWinnerSlot = getDisplayedWinnerSlot(frame);
          const breakerPlayer = match.players.find((player) => player.slot === frame.breakerSlot) || match.players[0];
          const canChangeBreaker = match.players.some((player) => player.occupied);
          const nextBreakerSlot = frame.breakerSlot === 1 ? 2 : 1;
          const frameCard = make("div", { className: "frame-card" });
          const frameHead = make("div", { className: "frame-head" });
          frameHead.append(make("h3", { text: translate("frameTitle", { frameNumber: frame.number }) }));
          if (displayedWinnerSlot != null) {
            const clearButton = make("button", { className: "ghost clear-button", text: translate("clearWinner") });
            clearButton.disabled = winnerPending;
            clearButton.addEventListener("click", () => {
              queueWinnerUpdate(frame.number, null);
            });
            frameHead.append(clearButton);
          }
          frameCard.append(frameHead);

          const frameTimes = make("div", { className: "frame-times" });
          frameTimes.append(
            make("span", { text: translate("frameStartLabel", { time: formatFrameTime(frame.startAt) }) }),
            make("span", { text: translate("frameEndLabel", { time: formatFrameTime(frame.endAt) }) })
          );
          frameCard.append(frameTimes);

          const breakerRow = make("div", { className: "breaker-row" });
          breakerRow.append(make("p", { text: translate("breakerLabel", { name: playerLabel(breakerPlayer) }) }));
          const breakerButton = make("button", { className: "ghost clear-button", text: translate("changeBreakerButton") });
          breakerButton.disabled = breakerPending || !canChangeBreaker;
          breakerButton.addEventListener("click", () => {
            void commitBreaker(frame.number, nextBreakerSlot);
          });
          breakerRow.append(breakerButton);
          frameCard.append(breakerRow);

          const winnerRow = make("div", { className: "winner-row" + (winnerPending ? " pending" : "") });
          match.players.forEach((player) => {
            const button = make("button", {
              className: "win-button" + (displayedWinnerSlot === player.slot ? " active" : ""),
              text: translate("winButton", { name: playerLabel(player) })
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
            stepperCard.append(make("p", { text: translate("foulLabel", { name: playerLabel(player) }) }));
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
        const leaveButton = make("button", { className: "danger", text: translate("leaveMatchButton") });
        leaveButton.addEventListener("click", () => {
          if (!window.confirm(translate("leaveMatchConfirm"))) return;
          runAction(translate("leaveMatchPending"), () => api("/api/matches/current/leave", { method: "POST" }));
        });
        const resetButton = make("button", { className: "ghost", text: translate("resetMatchButton") });
        resetButton.addEventListener("click", () => {
          if (!window.confirm(translate("resetMatchConfirm"))) return;
          runAction(translate("resetMatchPending"), () => api("/api/matches/current/reset", { method: "POST" }));
        });
        actions.append(leaveButton, resetButton);
        container.append(actions);
        shell.append(container);
      }

      function render() {
        if (state.match) {
          renderMatch();
        } else if (state.user && state.user.isAdmin) {
          renderSignedInAdminView();
        } else {
          renderSignedOutView();
        }
        syncRealtime();
      }

      async function loadSession() {
        const payload = await api("/api/session");
        applyPayload(payload);
        render();
        if (state.match) {
          setStatus(translate("statusMatchRestored"));
          return;
        }

        setStatus(state.user && state.user.isAdmin ? translate("statusAdminLoggedIn") : translate("statusLobbyReady"));
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
          setStatus(error instanceof Error ? error.message : translate("statusSyncFailed"));
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
        if (!matchCode) {
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
        renderSignedOutView();
        setStatus(error instanceof Error ? error.message : translate("statusConnectionFailed"));
      });
    </script>
  </body>
</html>`;
}

app.get("/", (c) => c.html(renderHomePage(c, "lobby")));

app.get("/admin", (c) => {
  const locale = resolveLocale(c);
  return c.html(renderAdminPage({ locale, messages: messages[locale] as MessageDictionary }));
});

app.get("/health", (c) => c.json({ ok: true, projectName: PROJECT_NAME, workerName: PROJECT_NAME }));

app.post("/api/locale", async (c) => {
  const t = getI18n(c);
  const payload = await readJson<{ locale?: unknown }>(c);
  const locale = typeof payload?.locale === "string" ? normalizeLocale(payload.locale) : null;

  if (!locale) {
    return c.json({ error: t("errorLocaleInvalid") }, 400);
  }

  setLocaleCookie(c, locale);
  return c.json({ ok: true, locale });
});

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
  const t = getI18n(c);
  const currentUser = await getAuthenticatedUser(c);

  if (currentUser) {
    if (isAdminUser(currentUser)) {
      return c.json({ user: serializeUser(currentUser), match: null });
    }

    const currentContext = await loadCurrentMatchContext(c, currentUser);

    if (currentContext) {
      return c.json({ error: t("errorNeedExitBeforeAdminLogin") }, 409);
    }

    await clearSession(c);
  }

  const payload = await readJson<{ password?: unknown }>(c);
  const password = typeof payload?.password === "string" ? payload.password : "";

  if (!password) {
    return c.json({ error: t("errorAdminPasswordRequired") }, 400);
  }

  const adminUser = await loginAdmin(c, password);

  if (!adminUser) {
    return c.json({ error: t("errorAdminPasswordInvalid") }, 401);
  }

  return c.json({ user: serializeUser(adminUser), match: null });
});

app.get("/api/admin/dashboard", async (c) => {
  const admin = await ensureAdminSession(c);

  if (admin.response) {
    return admin.response;
  }

  await cleanupStaleMatches(c);

  return c.json(await loadAdminDashboard(c.env.DB));
});

app.delete("/api/admin/history/:matchId/:archiveVersion", async (c) => {
  const t = getI18n(c);
  const admin = await ensureAdminSession(c);

  if (admin.response) {
    return admin.response;
  }

  const matchId = c.req.param("matchId");
  const archiveVersion = Number(c.req.param("archiveVersion"));

  if (!matchId || !Number.isInteger(archiveVersion) || archiveVersion <= 0) {
    return c.json({ error: t("errorHistoryNotFound") }, 400);
  }

  const removed = await deleteArchivedMatchById(c.env.DB, matchId, archiveVersion);

  if (!removed) {
    return c.json({ error: t("errorHistoryNotFound") }, 404);
  }

  return c.json({ ok: true });
});

app.post("/api/admin/matches/:matchId/force-end", async (c) => {
  const t = getI18n(c);
  const admin = await ensureAdminSession(c);

  if (admin.response) {
    return admin.response;
  }

  const matchId = c.req.param("matchId");

  if (!matchId) {
    return c.json({ error: t("errorMatchNotFound") }, 400);
  }

  const ended = await forceEndActiveMatch(c.env.DB, matchId);

  if (!ended) {
    return c.json({ error: t("errorMatchNotFound") }, 404);
  }

  notifyMatchRoom(c, matchId);
  return c.json({ ok: true });
});

app.post("/api/matches", async (c) => {
  const t = getI18n(c);
  await cleanupStaleMatches(c);
  const payload = await readJson<{ name?: unknown }>(c);
  const name = normalizeName(payload?.name);

  if (!name) {
    return c.json({ error: t("errorNameRequired", { max: String(MAX_NAME_LENGTH) }) }, 400);
  }

  const user = await upsertSessionUser(c, name);
  const existingContext = await loadCurrentMatchContext(c, user);

  if (existingContext) {
    return c.json({ error: t("errorAlreadyInOtherMatch") }, 409);
  }

  const db = getDatabase(c);
  const now = new Date();
  const matchId = crypto.randomUUID();
  const code = await generateMatchCode(c);

  await db.insert(matches).values({
    id: matchId,
    code,
    targetWins: DEFAULT_TARGET_WINS,
    openingSlot: 1,
    archiveVersion: 1,
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
    breakerSlot: null,
    winnerSlot: null,
    player1Fouls: 0,
    player2Fouls: 0,
    endedAt: null,
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
  const t = getI18n(c);
  await cleanupStaleMatches(c);
  const payload = await readJson<{ name?: unknown; code?: unknown }>(c);
  const name = normalizeName(payload?.name);
  const code = normalizeCode(payload?.code);

  if (!name) {
    return c.json({ error: t("errorNameRequired", { max: String(MAX_NAME_LENGTH) }) }, 400);
  }

  if (!code) {
    return c.json({ error: t("errorMatchCodeInvalid") }, 400);
  }

  const user = await upsertSessionUser(c, name);
  const existingContext = await loadCurrentMatchContext(c, user);

  if (existingContext) {
    if (existingContext.match.code === code) {
      const matchState = await loadMatchState(c, existingContext.match.id, user.id);
      return c.json({ user: serializeUser(user), match: matchState });
    }

    return c.json({ error: t("errorAlreadyInOtherMatch") }, 409);
  }

  const db = getDatabase(c);
  const match = await db.select().from(matches).where(eq(matches.code, code)).get();

  if (!match) {
    return c.json({ error: t("errorMatchCodeNotFound") }, 404);
  }

  let updateValues: Partial<typeof matches.$inferInsert> | null = null;

  if (!match.player1UserId) {
    updateValues = { player1UserId: user.id, player1Name: name };
  } else if (!match.player2UserId) {
    updateValues = { player2UserId: user.id, player2Name: name };
  } else {
    return c.json({ error: t("errorMatchFull") }, 409);
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
  const t = getI18n(c);
  const current = await ensureCurrentMatch(c);

  if (current.response) {
    return current.response;
  }

  const payload = await readJson<{ value?: unknown }>(c);
  const parsedValue = parseInteger(payload?.value);

  if (parsedValue == null) {
    return c.json({ error: t("errorTargetWinsInteger") }, 400);
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

  const updatedMatch = await db.select().from(matches).where(eq(matches.id, current.context!.match.id)).get();

  if (updatedMatch) {
    await normalizeFrames(c, updatedMatch, now);
    const frameRows = await db.select().from(frames).where(eq(frames.matchId, updatedMatch.id)).orderBy(asc(frames.frameNumber)).all();

    if (determineWinnerSlot(updatedMatch, frameRows)) {
      await syncArchivedMatch(db, updatedMatch, frameRows, "completed", now);
    } else {
      await deleteArchivedMatch(db, updatedMatch.id, updatedMatch.archiveVersion);
    }
  }

  notifyMatchRoom(c, current.context!.match.id);
  return respondWithCurrentState(c, current.user!);
});

app.post("/api/matches/current/frames/:frameNumber/breaker", async (c) => {
  const t = getI18n(c);
  const current = await ensureCurrentMatch(c);

  if (current.response) {
    return current.response;
  }

  const payload = await readJson<{ slot?: unknown }>(c);
  const frameNumber = Number(c.req.param("frameNumber"));
  const slot = parseInteger(payload?.slot);

  if (!Number.isInteger(frameNumber) || frameNumber <= 0) {
    return c.json({ error: t("errorFrameInvalid") }, 400);
  }

  if (!isPlayerSlot(slot)) {
    return c.json({ error: t("errorBreakerSlotInvalid") }, 400);
  }

  const db = getDatabase(c);
  const frame = await db
    .select()
    .from(frames)
    .where(and(eq(frames.matchId, current.context!.match.id), eq(frames.frameNumber, frameNumber)))
    .get();

  if (!frame) {
    return c.json({ error: t("errorFrameNotFound") }, 404);
  }

  const now = new Date();
  await db
    .update(frames)
    .set({
      breakerSlot: slot,
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

app.post("/api/matches/current/frames/:frameNumber/winner", async (c) => {
  const t = getI18n(c);
  const current = await ensureCurrentMatch(c);

  if (current.response) {
    return current.response;
  }

  const payload = await readJson<{ slot?: unknown }>(c);
  const frameNumber = Number(c.req.param("frameNumber"));

  if (!Number.isInteger(frameNumber) || frameNumber <= 0) {
    return c.json({ error: t("errorFrameInvalid") }, 400);
  }

  const slot = payload?.slot === null ? null : parseInteger(payload?.slot);

  if (slot !== null && slot !== 1 && slot !== 2) {
    return c.json({ error: t("errorWinnerSlotInvalid") }, 400);
  }

  const db = getDatabase(c);
  const frame = await db
    .select()
    .from(frames)
    .where(and(eq(frames.matchId, current.context!.match.id), eq(frames.frameNumber, frameNumber)))
    .get();

  if (!frame) {
    return c.json({ error: t("errorFrameNotFound") }, 404);
  }

  if (frame.winnerSlot === slot) {
    return respondWithCurrentState(c, current.user!);
  }

  const now = new Date();
  await db
    .update(frames)
    .set({
      winnerSlot: slot,
      endedAt: slot === null ? null : now,
      updatedAt: now,
    })
    .where(eq(frames.id, frame.id));

  await db
    .update(matches)
    .set({
      updatedAt: now,
    })
    .where(eq(matches.id, current.context!.match.id));

  const updatedMatch = await db.select().from(matches).where(eq(matches.id, current.context!.match.id)).get();

  if (updatedMatch) {
    await normalizeFrames(c, updatedMatch, now);
    const frameRows = await db.select().from(frames).where(eq(frames.matchId, updatedMatch.id)).orderBy(asc(frames.frameNumber)).all();

    if (determineWinnerSlot(updatedMatch, frameRows)) {
      await syncArchivedMatch(db, updatedMatch, frameRows, "completed", now);
    } else {
      await deleteArchivedMatch(db, updatedMatch.id, updatedMatch.archiveVersion);
    }
  }

  notifyMatchRoom(c, current.context!.match.id);
  return respondWithCurrentState(c, current.user!);
});

app.post("/api/matches/current/frames/:frameNumber/fouls", async (c) => {
  const t = getI18n(c);
  const current = await ensureCurrentMatch(c);

  if (current.response) {
    return current.response;
  }

  const payload = await readJson<{ slot?: unknown; value?: unknown }>(c);
  const frameNumber = Number(c.req.param("frameNumber"));
  const slot = parseInteger(payload?.slot);
  const value = parseInteger(payload?.value);

  if (!Number.isInteger(frameNumber) || frameNumber <= 0) {
    return c.json({ error: t("errorFrameInvalid") }, 400);
  }

  if (slot !== 1 && slot !== 2) {
    return c.json({ error: t("errorFoulSlotInvalid") }, 400);
  }

  if (value == null) {
    return c.json({ error: t("errorFoulValueInteger") }, 400);
  }

  const nextValue = clamp(value, 0, MAX_FOULS);
  const db = getDatabase(c);
  const frame = await db
    .select()
    .from(frames)
    .where(and(eq(frames.matchId, current.context!.match.id), eq(frames.frameNumber, frameNumber)))
    .get();

  if (!frame) {
    return c.json({ error: t("errorFrameNotFound") }, 404);
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
    breakerSlot: null,
    winnerSlot: null,
    player1Fouls: 0,
    player2Fouls: 0,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(matches)
    .set({
      targetWins: DEFAULT_TARGET_WINS,
      archiveVersion: current.context!.match.archiveVersion + 1,
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
  const remainingSlot = current.context!.slot === 1
    ? current.context!.match.player2UserId ? 2 : null
    : current.context!.match.player1UserId ? 1 : null;
  const updates = current.context!.slot === 1
    ? { player1UserId: null, openingSlot: remainingSlot ?? current.context!.match.openingSlot, updatedAt: now }
    : { player2UserId: null, openingSlot: remainingSlot ?? current.context!.match.openingSlot, updatedAt: now };

  await db.update(matches).set(updates).where(eq(matches.id, current.context!.match.id));

  if (remainingSlot) {
    await db
      .update(frames)
      .set({
        breakerSlot: remainingSlot,
        updatedAt: now,
      })
      .where(
        and(
          eq(frames.matchId, current.context!.match.id),
          isNull(frames.winnerSlot),
          eq(frames.player1Fouls, 0),
          eq(frames.player2Fouls, 0),
        ),
      );
  }

  await db
    .update(users)
    .set({
      currentMatchId: null,
      updatedAt: now,
    })
    .where(eq(users.id, current.user!.id));

  const updatedMatch = await db.select().from(matches).where(eq(matches.id, current.context!.match.id)).get();

  if (updatedMatch && !updatedMatch.player1UserId && !updatedMatch.player2UserId) {
    const frameRows = await db.select().from(frames).where(eq(frames.matchId, updatedMatch.id)).orderBy(asc(frames.frameNumber)).all();
    await syncArchivedMatch(db, updatedMatch, frameRows, "closed", now);
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
  const t = getI18n(c);
  if (c.req.header("upgrade") !== "websocket") {
    return c.text(t("websocketExpected"), 426);
  }

  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: t("errorNeedNameAndMatch") }, 401);
  }

  const context = await loadCurrentMatchContext(c, user);

  if (!context) {
    return c.json({ error: t("errorNoCurrentMatch") }, 404);
  }

  const stub = getMatchRoomStub(c, context.match.id);
  return stub.fetch(matchRoomConnectUrl(user.id, context.match.id), {
    headers: { Upgrade: "websocket" },
  });
});

export default app;

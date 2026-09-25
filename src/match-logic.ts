import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { matchHistory } from "./db/schema";

type Database = ReturnType<typeof drizzle>;

export type PlayerSlot = 1 | 2;

export const DEFAULT_TARGET_WINS = 7;
export const MAX_TARGET_WINS = 99;
export const MAX_FOULS = 99;
export const MAX_NAME_LENGTH = 24;
export const MATCH_IDLE_TTL_MS = 1000 * 60 * 60 * 6;

export type FrameRecord = {
  frameNumber: number;
  breakerSlot: PlayerSlot | null;
  winnerSlot: PlayerSlot | null;
  player1Fouls: number;
  player2Fouls: number;
  startedAt: number;
  endedAt: number | null;
};

export type MatchCore = {
  targetWins: number;
  openingSlot: PlayerSlot;
};

export type MatchSeats = {
  player1UserId: number | null;
  player1Name: string | null;
  player2UserId: number | null;
  player2Name: string | null;
};

export type MatchStatePayload = {
  code: string;
  targetWins: number;
  revision: number;
  players: Array<{
    slot: PlayerSlot;
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
  winnerSlot: PlayerSlot | null;
};

export type AdminMatchStatus = "ongoing" | "completed" | "closed" | "expired";
export type ArchivedMatchStatus = Exclude<AdminMatchStatus, "ongoing">;

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

export function isPlayerSlot(value: unknown): value is PlayerSlot {
  return value === 1 || value === 2;
}

export function parseInteger(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function oppositeSlot(slot: PlayerSlot): PlayerSlot {
  return slot === 1 ? 2 : 1;
}

export function resolveOpeningSlot(core: MatchCore): PlayerSlot {
  return isPlayerSlot(core.openingSlot) ? core.openingSlot : 1;
}

function resolveFrameBreakerSlot(
  core: MatchCore,
  frame: FrameRecord,
  previousBreakerSlot: PlayerSlot | null,
): PlayerSlot {
  if (isPlayerSlot(frame.breakerSlot)) {
    return frame.breakerSlot;
  }

  return previousBreakerSlot ? oppositeSlot(previousBreakerSlot) : resolveOpeningSlot(core);
}

export function resolveFrameBreakerSlots(core: MatchCore, frames: FrameRecord[]) {
  let previousBreakerSlot: PlayerSlot | null = null;

  return frames.map((frame) => {
    const breakerSlot = resolveFrameBreakerSlot(core, frame, previousBreakerSlot);
    previousBreakerSlot = breakerSlot;
    return breakerSlot;
  });
}

export function isFrameEmpty(frame: FrameRecord) {
  return frame.winnerSlot == null && frame.player1Fouls === 0 && frame.player2Fouls === 0;
}

export function calculateTotalWins(frames: FrameRecord[]) {
  let player1 = 0;
  let player2 = 0;

  for (const frame of frames) {
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

export function determineWinnerSlot(core: MatchCore, frames: FrameRecord[]): PlayerSlot | null {
  const totals = calculateTotalWins(frames);

  if (totals[1] >= core.targetWins) {
    return 1 as const;
  }

  if (totals[2] >= core.targetWins) {
    return 2 as const;
  }

  return null;
}

/**
 * Pure port of the historical `normalizeFrames` D1 routine: keep at most one
 * trailing empty frame, drop trailing empties once the match is decided, and
 * append the next frame as soon as the current one has a winner.
 */
export function normalizeFrames(core: MatchCore, frames: FrameRecord[], now: number): FrameRecord[] {
  if (frames.length === 0) {
    return [
      {
        frameNumber: 1,
        breakerSlot: null,
        winnerSlot: null,
        player1Fouls: 0,
        player2Fouls: 0,
        startedAt: now,
        endedAt: null,
      },
    ];
  }

  const working = frames.slice();

  if (determineWinnerSlot(core, working)) {
    while (working.length > 1 && isFrameEmpty(working[working.length - 1]!)) {
      working.pop();
    }

    return working;
  }

  while (
    working.length > 1
    && isFrameEmpty(working[working.length - 1]!)
    && isFrameEmpty(working[working.length - 2]!)
  ) {
    working.pop();
  }

  const lastFrame = working[working.length - 1]!;

  if (lastFrame.winnerSlot != null) {
    working.push({
      frameNumber: lastFrame.frameNumber + 1,
      breakerSlot: null,
      winnerSlot: null,
      player1Fouls: 0,
      player2Fouls: 0,
      startedAt: lastFrame.endedAt ?? now,
      endedAt: null,
    });
  }

  return working;
}

export function buildMatchState(options: {
  code: string;
  core: MatchCore;
  seats: MatchSeats;
  frames: FrameRecord[];
  revision: number;
  currentUserId: number | null;
}): MatchStatePayload {
  const { code, core, seats, frames, revision, currentUserId } = options;
  const breakerSlots = resolveFrameBreakerSlots(core, frames);
  const totalWins = calculateTotalWins(frames);

  return {
    code,
    targetWins: core.targetWins,
    revision,
    players: [
      {
        slot: 1 as const,
        name: seats.player1UserId ? seats.player1Name : null,
        occupied: Boolean(seats.player1UserId),
        isSelf: seats.player1UserId === currentUserId,
      },
      {
        slot: 2 as const,
        name: seats.player2UserId ? seats.player2Name : null,
        occupied: Boolean(seats.player2UserId),
        isSelf: seats.player2UserId === currentUserId,
      },
    ],
    frames: frames.map((frame, index) => ({
      number: frame.frameNumber,
      breakerSlot: breakerSlots[index]!,
      winnerSlot: frame.winnerSlot,
      player1Fouls: frame.player1Fouls,
      player2Fouls: frame.player2Fouls,
      startAt: new Date(frame.startedAt).toISOString(),
      endAt: frame.winnerSlot != null && frame.endedAt != null ? new Date(frame.endedAt).toISOString() : null,
    })),
    totalWins,
    winnerSlot: determineWinnerSlot(core, frames),
  };
}

export type ArchiveMatchInput = {
  matchId: string;
  code: string;
  archiveVersion: number;
  core: MatchCore;
  seats: MatchSeats;
  createdAtMs: number;
  updatedAtMs: number;
};

export function serializeMatchSnapshot(
  input: ArchiveMatchInput,
  frames: FrameRecord[],
  status: AdminMatchStatus,
  archivedAt: Date | null,
): AdminMatchSnapshot {
  const breakerSlots = resolveFrameBreakerSlots(input.core, frames);
  const totalWins = calculateTotalWins(frames);

  return {
    matchId: input.matchId,
    code: input.code,
    archiveVersion: input.archiveVersion,
    status,
    targetWins: input.core.targetWins,
    players: {
      1: input.seats.player1Name ?? null,
      2: input.seats.player2Name ?? null,
    },
    frames: frames.map((frame, index) => ({
      number: frame.frameNumber,
      breakerSlot: breakerSlots[index] ?? null,
      winnerSlot: frame.winnerSlot,
      player1Fouls: frame.player1Fouls,
      player2Fouls: frame.player2Fouls,
    })),
    totalWins,
    winnerSlot: determineWinnerSlot(input.core, frames),
    createdAt: new Date(input.createdAtMs).toISOString(),
    updatedAt: new Date(input.updatedAtMs).toISOString(),
    archivedAt: archivedAt ? archivedAt.toISOString() : null,
  };
}

export async function upsertArchivedMatch(
  db: Database,
  input: ArchiveMatchInput,
  frames: FrameRecord[],
  fallbackStatus: ArchivedMatchStatus,
  archivedAt = new Date(),
) {
  const status: ArchivedMatchStatus = determineWinnerSlot(input.core, frames) ? "completed" : fallbackStatus;
  const snapshot = serializeMatchSnapshot(input, frames, status, archivedAt);
  const values = {
    matchId: input.matchId,
    archiveVersion: input.archiveVersion,
    code: input.code,
    status,
    winnerSlot: snapshot.winnerSlot,
    targetWins: input.core.targetWins,
    player1Name: snapshot.players[1],
    player2Name: snapshot.players[2],
    player1Wins: snapshot.totalWins[1],
    player2Wins: snapshot.totalWins[2],
    createdAt: new Date(input.createdAtMs),
    updatedAt: new Date(input.updatedAtMs),
    archivedAt,
    snapshot: JSON.stringify(snapshot),
  };

  const existing = await db
    .select({ id: matchHistory.id })
    .from(matchHistory)
    .where(and(eq(matchHistory.matchId, input.matchId), eq(matchHistory.archiveVersion, input.archiveVersion)))
    .get();

  if (existing) {
    await db.update(matchHistory).set(values).where(eq(matchHistory.id, existing.id));
  } else {
    await db.insert(matchHistory).values(values);
  }

  return snapshot;
}

export async function deleteArchivedMatchVersion(db: Database, matchId: string, archiveVersion: number) {
  await db
    .delete(matchHistory)
    .where(and(eq(matchHistory.matchId, matchId), eq(matchHistory.archiveVersion, archiveVersion)));
}

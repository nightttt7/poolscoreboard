/// <reference types="@cloudflare/workers-types" />

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { frames as legacyFrames, matches, users } from "./db/schema";
import {
  DEFAULT_TARGET_WINS,
  MATCH_IDLE_TTL_MS,
  MAX_FOULS,
  MAX_TARGET_WINS,
  buildMatchState,
  clamp,
  deleteArchivedMatchVersion,
  determineWinnerSlot,
  isPlayerSlot,
  normalizeFrames,
  upsertArchivedMatch,
  type ArchiveMatchInput,
  type FrameRecord,
  type MatchCore,
  type MatchSeats,
  type MatchStatePayload,
  type PlayerSlot,
} from "./match-logic";

const ROOM_PROTOCOL = "https://match-room.internal";
const REGISTRY_TOUCH_INTERVAL_MS = 1000 * 60 * 5;

type RoomBindings = {
  DB: D1Database;
};

type ConnectionAttachment = {
  userId: number;
  matchId: string;
};

export type MatchRoomCommand =
  | { type: "setTargetWins"; value: number }
  | { type: "setBreaker"; frameNumber: number; slot: PlayerSlot }
  | { type: "setWinner"; frameNumber: number; slot: PlayerSlot | null }
  | { type: "setFouls"; frameNumber: number; slot: PlayerSlot; value: number }
  | { type: "reset" };

type RoomState = {
  matchId: string;
  code: string;
  archiveVersion: number;
  createdAtMs: number;
  updatedAtMs: number;
  core: MatchCore;
  seats: MatchSeats;
  revision: number;
  lastRegistryTouchMs: number;
};

class RoomError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * MatchRoom is the source of truth for one live match. Frame-level mutations
 * run against the object's local SQLite storage (no network hops), and every
 * change is pushed to both players' WebSockets. D1 keeps only the match
 * registry (code, seats) and the archived history, written behind by this
 * object on completion, closure, and expiry.
 *
 * All routes except /connect are internal: the object is reachable only
 * through the MATCH_ROOM binding, never from the public internet.
 */
export class MatchRoom implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: RoomBindings;
  private room: RoomState | null = null;

  constructor(state: DurableObjectState, env: RoomBindings) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      return this.handleConnect(request, url);
    }

    if (url.pathname === "/state" && request.method === "GET") {
      return this.handleState(url);
    }

    if (url.pathname === "/command" && request.method === "POST") {
      return this.handleCommandRequest(request, url);
    }

    if (url.pathname === "/close" && request.method === "POST") {
      const payload = await readJson<{ status?: unknown }>(request);
      const status = payload?.status === "expired" ? "expired" : "closed";
      const closed = await this.closeMatch(status, url.searchParams.get("matchId"));
      return closed ? new Response(null, { status: 204 }) : new Response("match not found", { status: 404 });
    }

    if (url.pathname === "/notify" && request.method === "POST") {
      const payload = await readJson<{ remainingSlot?: unknown }>(request);
      await this.handleRegistryNotification(payload?.remainingSlot, url.searchParams.get("matchId"));
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.closeMatch("expired", null);
  }

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const userId = Number(url.searchParams.get("userId"));
    const matchId = url.searchParams.get("matchId");

    if (!Number.isInteger(userId) || userId <= 0 || !matchId) {
      return new Response("invalid connection metadata", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);
    server.serializeAttachment({ userId, matchId } satisfies ConnectionAttachment);

    void this.sendStateToSocket(server, userId).catch(() => {
      try {
        server.close(1011, "room unavailable");
      } catch {
        // Already closed.
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleState(url: URL): Promise<Response> {
    const userIdParam = Number(url.searchParams.get("userId"));
    const userId = Number.isInteger(userIdParam) && userIdParam > 0 ? userIdParam : null;

    try {
      await this.ensureReady(url.searchParams.get("matchId"));
    } catch (error) {
      if (error instanceof RoomError) {
        return new Response(JSON.stringify({ error: error.code }), { status: error.status });
      }

      throw error;
    }

    return Response.json(await this.buildState(userId));
  }

  private async handleCommandRequest(request: Request, url: URL): Promise<Response> {
    const payload = await readJson<{ userId?: unknown; command?: unknown }>(request);
    const userId = Number(payload?.userId);
    const command = parseCommand(payload?.command);

    if (!Number.isInteger(userId) || userId <= 0 || !command) {
      return new Response(JSON.stringify({ error: "invalid_command" }), { status: 400 });
    }

    const result = await this.runCommand(userId, command, url.searchParams.get("matchId"));

    if (result.error) {
      return new Response(JSON.stringify({ error: result.error }), { status: result.status });
    }

    return Response.json({ match: await this.buildState(userId) });
  }

  private async handleRegistryNotification(remainingSlot: unknown, matchId: string | null) {
    const room = await this.loadRoom(matchId, false);

    if (!room) {
      await this.closeSockets();
      return;
    }

    const db = drizzle(this.env.DB);
    const registryRow = await db.select().from(matches).where(eq(matches.id, room.matchId)).get();

    if (!registryRow) {
      await this.closeSockets();
      return;
    }

    room.seats = {
      player1UserId: registryRow.player1UserId,
      player1Name: registryRow.player1Name,
      player2UserId: registryRow.player2UserId,
      player2Name: registryRow.player2Name,
    };
    room.core.openingSlot = isPlayerSlot(registryRow.openingSlot) ? registryRow.openingSlot : room.core.openingSlot;
    room.updatedAtMs = registryRow.updatedAt.getTime();

    if (isPlayerSlot(remainingSlot)) {
      const now = Date.now();
      const previousFrames = await this.readFrames();
      const nextFrames = previousFrames.map((frame) => ({ ...frame }));
      let mutated = false;

      for (const frame of nextFrames) {
        if (
          frame.winnerSlot == null
          && frame.player1Fouls === 0
          && frame.player2Fouls === 0
          && frame.breakerSlot !== remainingSlot
        ) {
          frame.breakerSlot = remainingSlot;
          mutated = true;
        }
      }

      if (mutated) {
        await this.writeFrames(nextFrames, previousFrames, now);
      }
    }

    room.revision += 1;
    room.updatedAtMs = Date.now();
    await this.persistRoom(room);
    await this.touchRegistryUpdatedAt(room);
    await this.resetAlarm();
    await this.broadcastState();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const envelope = parsed as { type?: unknown; command?: unknown };

    if (envelope.type === "ping") {
      this.trySend(ws, JSON.stringify({ type: "pong" }));
      return;
    }

    if (envelope.type === "refresh") {
      const attachment = this.attachmentOf(ws);
      await this.sendStateToSocket(ws, attachment?.userId ?? null).catch(() => undefined);
      return;
    }

    if (envelope.type === "command") {
      const command = parseCommand(envelope.command);
      const attachment = this.attachmentOf(ws);

      if (!command || !attachment) {
        this.trySend(ws, JSON.stringify({ type: "command-error", error: "invalid_command" }));
        return;
      }

      const result = await this.runCommand(attachment.userId, command, null);

      if (result.error) {
        this.trySend(ws, JSON.stringify({ type: "command-error", error: result.error }));
      }

      return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close(code, "closing");
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "internal error");
    } catch {
      // Already closed.
    }
  }

  private async ensureReady(matchId: string | null): Promise<RoomState> {
    const room = await this.loadRoom(matchId, true);

    if (!room) {
      throw new RoomError(404, "match_not_found");
    }

    return room;
  }

  /**
   * Loads (or rehydrates after a restart) the room view. The D1 registry row
   * is authoritative for identity (code, seats, archive version); this
   * object's SQLite storage is authoritative for frames.
   */
  private async loadRoom(matchIdParam: string | null, required: boolean): Promise<RoomState | null> {
    if (this.room) {
      return this.room;
    }

    const closedAt = await this.state.storage.get<number>("closedAt");

    if (closedAt) {
      return null;
    }

    const matchId = matchIdParam ?? (await this.state.storage.get<string>("matchId")) ?? null;

    if (!matchId) {
      throw new RoomError(400, "missing_match_id");
    }

    await this.state.storage.put("matchId", matchId);

    const db = drizzle(this.env.DB);
    const registryRow = await db.select().from(matches).where(eq(matches.id, matchId)).get();

    if (!registryRow) {
      if (required) {
        await this.state.storage.put("closedAt", Date.now());
      }

      return null;
    }

    await this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS frames (
        frameNumber INTEGER PRIMARY KEY,
        breakerSlot INTEGER,
        winnerSlot INTEGER,
        player1Fouls INTEGER NOT NULL DEFAULT 0,
        player2Fouls INTEGER NOT NULL DEFAULT 0,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        updatedAt INTEGER NOT NULL
      )
    `);

    const revision = (await this.state.storage.get<number>("revision")) ?? 0;
    const core = this.coreOf(registryRow.targetWins, registryRow.openingSlot);
    const frames = await this.readFrames();

    if (frames.length === 0) {
      const createdAtMs = registryRow.createdAt.getTime();
      await this.writeFrames(normalizeFrames(core, [], createdAtMs), [], createdAtMs);
    }

    this.room = {
      matchId,
      code: registryRow.code,
      archiveVersion: registryRow.archiveVersion,
      createdAtMs: registryRow.createdAt.getTime(),
      updatedAtMs: registryRow.updatedAt.getTime(),
      core,
      seats: {
        player1UserId: registryRow.player1UserId,
        player1Name: registryRow.player1Name,
        player2UserId: registryRow.player2UserId,
        player2Name: registryRow.player2Name,
      },
      revision,
      lastRegistryTouchMs: registryRow.updatedAt.getTime(),
    };

    await this.resetAlarm();
    return this.room;
  }

  private coreOf(targetWins: number, openingSlot: number | null): MatchCore {
    return {
      targetWins: clamp(Number.isFinite(targetWins) ? targetWins : DEFAULT_TARGET_WINS, 1, MAX_TARGET_WINS),
      openingSlot: isPlayerSlot(openingSlot) ? openingSlot : 1,
    };
  }

  private async runCommand(
    userId: number,
    command: MatchRoomCommand,
    matchId: string | null,
  ): Promise<{ error: null } | { error: string; status: number }> {
    let room: RoomState;

    try {
      room = await this.ensureReady(matchId);
    } catch (error) {
      if (error instanceof RoomError) {
        return { error: error.code, status: error.status };
      }

      throw error;
    }

    const isPlayer = room.seats.player1UserId === userId || room.seats.player2UserId === userId;

    if (!isPlayer) {
      return { error: "forbidden", status: 403 };
    }

    const now = Date.now();
    const previousFrames = await this.readFrames();
    const nextFrames = previousFrames.map((frame) => ({ ...frame }));
    let core = room.core;
    let archiveVersion = room.archiveVersion;
    let needsArchiveSync = false;
    let needsRegistryPersist = false;

    switch (command.type) {
      case "setTargetWins": {
        const value = clamp(command.value, 1, MAX_TARGET_WINS);

        if (core.targetWins !== value) {
          core = { ...core, targetWins: value };
          needsArchiveSync = true;
          needsRegistryPersist = true;
        }

        break;
      }

      case "setBreaker": {
        const frame = nextFrames.find((candidate) => candidate.frameNumber === command.frameNumber);

        if (!frame) {
          return { error: "frame_not_found", status: 404 };
        }

        frame.breakerSlot = command.slot;
        break;
      }

      case "setWinner": {
        const frame = nextFrames.find((candidate) => candidate.frameNumber === command.frameNumber);

        if (!frame) {
          return { error: "frame_not_found", status: 404 };
        }

        if (frame.winnerSlot !== command.slot) {
          frame.winnerSlot = command.slot;
          frame.endedAt = command.slot === null ? null : now;
          needsArchiveSync = true;
        }

        break;
      }

      case "setFouls": {
        const frame = nextFrames.find((candidate) => candidate.frameNumber === command.frameNumber);

        if (!frame) {
          return { error: "frame_not_found", status: 404 };
        }

        const value = clamp(command.value, 0, MAX_FOULS);

        if (command.slot === 1) {
          frame.player1Fouls = value;
        } else {
          frame.player2Fouls = value;
        }

        break;
      }

      case "reset": {
        core = { ...core, targetWins: DEFAULT_TARGET_WINS };
        archiveVersion += 1;
        needsRegistryPersist = true;
        break;
      }
    }

    // Frame list maintenance (appending the next frame, trimming empties) is
    // applied on every mutation that can change winners, mirroring the
    // historical `normalizeFrames` behavior. Reset starts from an empty list.
    let finalFrames: FrameRecord[];

    if (command.type === "reset") {
      finalFrames = normalizeFrames(core, [], now);
    } else if (command.type === "setWinner" || command.type === "setTargetWins") {
      finalFrames = normalizeFrames(core, nextFrames, now);
    } else {
      finalFrames = nextFrames;
    }

    await this.writeFrames(finalFrames, previousFrames, now);

    room.core = core;
    room.archiveVersion = archiveVersion;
    room.revision += 1;
    room.updatedAtMs = now;
    await this.persistRoom(room);
    await this.resetAlarm();

    const db = drizzle(this.env.DB);

    if (needsRegistryPersist) {
      await db
        .update(matches)
        .set({
          targetWins: room.core.targetWins,
          ...(command.type === "reset" ? { archiveVersion: room.archiveVersion } : {}),
          updatedAt: new Date(now),
        })
        .where(eq(matches.id, room.matchId));
      room.lastRegistryTouchMs = now;
    }

    if (needsArchiveSync) {
      if (determineWinnerSlot(room.core, finalFrames)) {
        await upsertArchivedMatch(db, this.archiveInputOf(room), finalFrames, "completed", new Date(now));
      } else {
        await deleteArchivedMatchVersion(db, room.matchId, room.archiveVersion);
      }
    }

    await this.touchRegistryUpdatedAt(room);
    await this.broadcastState();
    return { error: null };
  }

  private async closeMatch(status: "closed" | "expired", matchIdParam: string | null): Promise<boolean> {
    const room = await this.loadRoom(matchIdParam, false);

    if (!room) {
      return false;
    }

    const now = new Date();
    const db = drizzle(this.env.DB);
    const frameRows = await this.readFrames();

    await upsertArchivedMatch(db, this.archiveInputOf(room), frameRows, status, now);
    await db
      .update(users)
      .set({ currentMatchId: null, updatedAt: now })
      .where(eq(users.currentMatchId, room.matchId));
    await db.delete(legacyFrames).where(eq(legacyFrames.matchId, room.matchId));
    await db.delete(matches).where(eq(matches.id, room.matchId));

    await this.state.storage.put("closedAt", now.getTime());
    this.room = null;
    await this.state.storage.deleteAlarm();

    await this.closeSockets();
    return true;
  }

  private archiveInputOf(room: RoomState): ArchiveMatchInput {
    return {
      matchId: room.matchId,
      code: room.code,
      archiveVersion: room.archiveVersion,
      core: room.core,
      seats: room.seats,
      createdAtMs: room.createdAtMs,
      updatedAtMs: room.updatedAtMs,
    };
  }

  private async touchRegistryUpdatedAt(room: RoomState) {
    const now = Date.now();

    if (now - room.lastRegistryTouchMs < REGISTRY_TOUCH_INTERVAL_MS) {
      return;
    }

    const db = drizzle(this.env.DB);
    await db.update(matches).set({ updatedAt: new Date(now) }).where(eq(matches.id, room.matchId));
    room.lastRegistryTouchMs = now;
  }

  private async resetAlarm() {
    await this.state.storage.setAlarm(Date.now() + MATCH_IDLE_TTL_MS);
  }

  private async readFrames(): Promise<FrameRecord[]> {
    const cursor = this.state.storage.sql.exec(
      "SELECT frameNumber, breakerSlot, winnerSlot, player1Fouls, player2Fouls, startedAt, endedAt FROM frames ORDER BY frameNumber ASC",
    );
    const rows: FrameRecord[] = [];

    for (const row of cursor.toArray()) {
      const breakerSlot = row.breakerSlot;
      const winnerSlot = row.winnerSlot;

      rows.push({
        frameNumber: Number(row.frameNumber),
        breakerSlot: isPlayerSlot(breakerSlot) ? breakerSlot : null,
        winnerSlot: isPlayerSlot(winnerSlot) ? winnerSlot : null,
        player1Fouls: Number(row.player1Fouls ?? 0),
        player2Fouls: Number(row.player2Fouls ?? 0),
        startedAt: Number(row.startedAt),
        endedAt: row.endedAt == null ? null : Number(row.endedAt),
      });
    }

    return rows;
  }

  private async writeFrames(next: FrameRecord[], previous: FrameRecord[], now: number) {
    const previousByNumber = new Map(previous.map((frame) => [frame.frameNumber, frame]));

    for (const frame of next) {
      const before = previousByNumber.get(frame.frameNumber);

      if (
        !before
        || before.breakerSlot !== frame.breakerSlot
        || before.winnerSlot !== frame.winnerSlot
        || before.player1Fouls !== frame.player1Fouls
        || before.player2Fouls !== frame.player2Fouls
        || before.endedAt !== frame.endedAt
      ) {
        this.state.storage.sql.exec(
          `INSERT INTO frames (frameNumber, breakerSlot, winnerSlot, player1Fouls, player2Fouls, startedAt, endedAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(frameNumber) DO UPDATE SET
             breakerSlot = excluded.breakerSlot,
             winnerSlot = excluded.winnerSlot,
             player1Fouls = excluded.player1Fouls,
             player2Fouls = excluded.player2Fouls,
             endedAt = excluded.endedAt,
             updatedAt = excluded.updatedAt`,
          frame.frameNumber,
          frame.breakerSlot,
          frame.winnerSlot,
          frame.player1Fouls,
          frame.player2Fouls,
          frame.startedAt,
          frame.endedAt,
          now,
        );
      }
    }

    const nextNumbers = new Set(next.map((frame) => frame.frameNumber));

    for (const frame of previous) {
      if (!nextNumbers.has(frame.frameNumber)) {
        this.state.storage.sql.exec("DELETE FROM frames WHERE frameNumber = ?", frame.frameNumber);
      }
    }
  }

  private async persistRoom(room: RoomState) {
    await this.state.storage.put("revision", room.revision);
  }

  private async buildState(currentUserId: number | null): Promise<MatchStatePayload> {
    const room = this.room!;
    const frames = await this.readFrames();

    return buildMatchState({
      code: room.code,
      core: room.core,
      seats: room.seats,
      frames,
      revision: room.revision,
      currentUserId,
    });
  }

  private async sendStateToSocket(ws: WebSocket, userId: number | null) {
    await this.ensureReady(null);
    const payload = await this.buildState(userId);
    this.trySend(ws, JSON.stringify({ type: "match-updated", match: payload }));
  }

  private async broadcastState() {
    const sockets = this.state.getWebSockets();

    if (sockets.length === 0) {
      return;
    }

    for (const ws of sockets) {
      const attachment = this.attachmentOf(ws);
      const payload = await this.buildState(attachment?.userId ?? null);
      this.trySend(ws, JSON.stringify({ type: "match-updated", match: payload }));
    }
  }

  private async closeSockets() {
    const message = JSON.stringify({ type: "match-closed" });

    for (const ws of this.state.getWebSockets()) {
      this.trySend(ws, message);

      try {
        ws.close(1000, "match closed");
      } catch {
        // Already closed.
      }
    }
  }

  private attachmentOf(ws: WebSocket): ConnectionAttachment | null {
    try {
      const attachment = ws.deserializeAttachment() as Partial<ConnectionAttachment> | null;

      if (attachment && Number.isInteger(attachment.userId) && typeof attachment.matchId === "string") {
        return attachment as ConnectionAttachment;
      }
    } catch {
      // Malformed attachment; treat as anonymous.
    }

    return null;
  }

  private trySend(ws: WebSocket, message: string) {
    try {
      ws.send(message);
    } catch {
      // Ignore broken connections; hibernation lifecycle will clean them up.
    }
  }
}

function readJson<T>(request: Request): Promise<T | null> {
  return request.json<T>().catch(() => null);
}

function parseCommand(value: unknown): MatchRoomCommand | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const command = value as Record<string, unknown>;

  if (command.type === "setTargetWins" && typeof command.value === "number" && Number.isInteger(command.value)) {
    return { type: "setTargetWins", value: command.value };
  }

  if (
    command.type === "setBreaker"
    && typeof command.frameNumber === "number"
    && Number.isInteger(command.frameNumber)
    && isPlayerSlot(command.slot)
  ) {
    return { type: "setBreaker", frameNumber: command.frameNumber, slot: command.slot };
  }

  if (
    command.type === "setWinner"
    && typeof command.frameNumber === "number"
    && Number.isInteger(command.frameNumber)
    && (command.slot === null || isPlayerSlot(command.slot))
  ) {
    return { type: "setWinner", frameNumber: command.frameNumber, slot: command.slot };
  }

  if (
    command.type === "setFouls"
    && typeof command.frameNumber === "number"
    && Number.isInteger(command.frameNumber)
    && isPlayerSlot(command.slot)
    && typeof command.value === "number"
    && Number.isInteger(command.value)
  ) {
    return { type: "setFouls", frameNumber: command.frameNumber, slot: command.slot, value: command.value };
  }

  if (command.type === "reset") {
    return { type: "reset" };
  }

  return null;
}

export function matchRoomConnectUrl(userId: number, matchId: string) {
  const url = new URL("/connect", ROOM_PROTOCOL);
  url.searchParams.set("userId", String(userId));
  url.searchParams.set("matchId", matchId);
  return url.toString();
}

export function matchRoomStateUrl(userId: number | null, matchId: string) {
  const url = new URL("/state", ROOM_PROTOCOL);
  url.searchParams.set("userId", userId == null ? "" : String(userId));
  url.searchParams.set("matchId", matchId);
  return url.toString();
}

export function matchRoomCommandUrl(matchId: string) {
  const url = new URL("/command", ROOM_PROTOCOL);
  url.searchParams.set("matchId", matchId);
  return url.toString();
}

export function matchRoomCloseUrl(matchId: string) {
  const url = new URL("/close", ROOM_PROTOCOL);
  url.searchParams.set("matchId", matchId);
  return url.toString();
}

export function matchRoomNotifyUrl(matchId: string) {
  const url = new URL("/notify", ROOM_PROTOCOL);
  url.searchParams.set("matchId", matchId);
  return url.toString();
}

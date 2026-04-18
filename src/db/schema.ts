import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  currentMatchId: text("current_match_id"),
  username: text("username"),
  passwordSalt: text("password_salt"),
  passwordHash: text("password_hash"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const matches = sqliteTable("matches", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  targetWins: integer("target_wins").notNull().default(7),
  openingSlot: integer("opening_slot").notNull().default(1),
  player1UserId: integer("player1_user_id"),
  player1Name: text("player1_name"),
  player2UserId: integer("player2_user_id"),
  player2Name: text("player2_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const frames = sqliteTable("frames", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  matchId: text("match_id").notNull().references(() => matches.id),
  frameNumber: integer("frame_number").notNull(),
  breakerSlot: integer("breaker_slot"),
  winnerSlot: integer("winner_slot"),
  player1Fouls: integer("player1_fouls").notNull().default(0),
  player2Fouls: integer("player2_fouls").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type User = typeof users.$inferSelect;
export type Match = typeof matches.$inferSelect;
export type Frame = typeof frames.$inferSelect;

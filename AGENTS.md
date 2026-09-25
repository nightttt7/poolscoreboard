# AGENTS.md

Guidance for AI coding agents working in this repository. These rules apply repo-wide unless a section names more specific paths.

## Project Ground Truth

- Treat this repository as the standalone `poolscoreboard` service: Hono + Cloudflare Workers + D1 + the `MatchRoom` Durable Object.
- Keep naming explicit and stable: package name and Worker name are `poolscoreboard`; the D1 database name is `poolscoreboard-prod`. Keep naming-sensitive configuration explicit in source files instead of regenerating it from helper scripts.

## Live-Match Architecture

- The `MatchRoom` Durable Object is the source of truth for an in-progress match: frames, fouls, winners, breaker slots, and target wins live in the object's SQLite storage, and every mutation is pushed to both players' WebSockets as a full state payload.
- D1 holds only the match registry (`matches`: code, seats, archive version) and the immutable archive (`match_history`). The room writes archives behind on completion, closure, and expiry. Do not move frame-level writes back onto the request hot path.
- Match expiry runs on each room's storage alarm; a Cron Trigger (`0 */6 * * *`) invokes the Worker's `scheduled` sweeper only as a backstop (stale registry rows, expired sessions, legacy `frames` rows). Do not re-add per-request table scans like the historical `cleanupStaleMatches`.
- The client keeps a heartbeat (25s ping, reconnect after two missed rounds) and resyncs on `visibilitychange`/`online`; treat silent socket death as the primary historical cause of two-user desync when changing realtime code.

## Auth & Sessions

- Data-changing routes must require authenticated sessions.
- Prefer also protecting data-reading routes when the data is prototype-private, unless the user explicitly asks for public reads.
- Keep auth database-backed and extensible. Do not replace it with hardcoded in-memory credentials.
- For the pool scoreboard UI, players identify with a display name plus a D1-backed cookie session; do not switch gameplay back to unsigned client-only state.

## Admin Account Rules

- The initial admin username is fixed as `admin`.
- The initial admin password comes from the deployed Worker secret `ADMIN_PASSWORD`, and from the local `ADMIN_PASSWORD` environment variable during local development. Never hardcode credentials in source.
- Keep admin bootstrap simple: lazily create the `admin` user during login instead of adding separate migration bootstrap scripts unless the user explicitly asks for them.
- Admin-only read routes that expose live matches or archived match history must require an authenticated admin session.
- Preserve the dedicated `/admin` login page. Do not reintroduce a visible admin password field on the homepage, and keep homepage player inputs treated as non-credential fields.
- Keep admin dashboard concerns in a dedicated module (`src/admin.ts`) instead of folding them back into the lobby shell in `src/app.ts`.
- If `ADMIN_PASSWORD` changes locally outside GitHub Actions deploys, document that operators must reset the database or update the local `admin` record explicitly.

## Durable Object Trust Boundary

- All `MatchRoom` routes except `/connect` are internal: the object is reachable only through the `MATCH_ROOM` binding, never from the public internet. Do not expose the room protocol over public HTTP.
- The Worker authenticates every mutating route and forwards the verified `userId` to the room; the room re-checks seat membership before applying any command. Never let the room trust a client-supplied identity.
- WebSocket commands are authenticated by the connection's serialized attachment, populated only by the authenticated `/api/matches/current/socket` upgrade route.
- Match-state payloads must not leak user IDs; expose seat membership only through the `isSelf` boolean.

## Data & Schema Rules

- Preserve persistent match history in D1. Completed matches and fully closed or expired matches should be archived for admin review, and resetting a live match should start a new archive version instead of overwriting prior history.
- Auth-related schema changes must preserve a path for bootstrapping a fresh environment from zero.
- Match lifecycle changes that matter to admin operations should be persisted in D1 rather than kept only in transient in-memory state; when a match is won, fully closed, or expired, archive enough data for `/admin` to inspect both summary and frame-by-frame history later.
- Keep migrations readable and preserve the numeric ordering prefix in `migrations/`, because migration ordering depends on it.
- If auth/session behavior changes, update tests to verify unauthenticated rejection and authenticated success.

## Deployment Reality (`.github/workflows/**`)

- Do not imply that first deploy is fully automatic unless the user has manually configured `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `ADMIN_PASSWORD`.
- Deploy automation should fail fast and clearly name any missing required Actions secrets before running Cloudflare commands.
- After resolving the remote D1 database id, make subsequent remote Wrangler commands use that resolved id instead of the placeholder `wrangler.jsonc` UUID.
- Ensure the workflow uploads or refreshes the Worker secret before deploying code that depends on it, and refresh the remote `admin` user's password from `ADMIN_PASSWORD` on every deploy after migrations run.

## Local Database Workflow

- Prefer Wrangler local D1 backed by persisted SQLite state under `.wrangler/state`.
- When a clean local database is needed, prefer `npm run db:reset:local` instead of inventing ad-hoc cleanup steps.

## Documentation Rules

- Keep README concise and optimized for humans. Put the most emphasis on steps AI cannot complete automatically (GitHub secrets, Cloudflare credentials, local secret files), and clearly separate human-only setup from AI-automatable steps.
- Keep detailed development conventions in this file rather than bloating the README.
- When changing schema, auth, deployment, or project workflow, update this file in the same change. It is expected to evolve continuously with the project.

## Working Style

Behavioral guidelines to reduce common LLM coding mistakes. For trivial tasks, use judgment.

**Tradeoff:** These guidelines bias toward caution over speed.

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that your own changes made unused.
- Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

Define success criteria. Loop until verified.

- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Ensure tests pass before and after."

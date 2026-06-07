# poolscoreboard

A mobile-first scoreboard for two-player pool (billiards) matches, running on Hono + Cloudflare Workers + D1.

Players just enter a name, create or join a match by code, and keep score from their phones. Updates sync live between both players' screens.

## Using the app

**Players**

1. Open the site and enter your name.
2. Create a new match, or join an existing one by entering its code.
3. Share the match code with your opponent so they can join the open seat.
4. Track the match from your phone:
   - Set the target number of frames to win (race-to).
   - Mark the winner of each frame and adjust fouls for either player.
   - The breaker is shown for every frame and rotates automatically; you can change it manually.
   - The total score is read-only, and a winner is announced automatically once the target is reached.

A player can only be in one match at a time, and each match holds two players. If someone leaves, a new player can take the open seat.

**Admins**

Visit `/admin` and sign in with the admin password to:

- Review matches that are currently in progress.
- Browse archived match history (completed, closed, or expired sessions).

**Language**

The interface ships with English (default) and Chinese, switchable from the language selector. Your choice is remembered via a cookie.

## Self-hosting

This app deploys to Cloudflare. Deployment runs automatically via GitHub Actions on every push to `main`, but it will fail fast until you provide the required credentials yourself.

### 1. Set the required credentials (manual, one-time)

Configure the **same** three values in both places:

- **GitHub repository → Settings → Secrets and variables → Actions**
- **Your local machine** (as permanent environment variables, for local development)

| Name                    | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API token with Workers + D1 permissions    |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID                            |
| `ADMIN_PASSWORD`        | Password for the built-in `admin` account on `/admin` |

> The `admin` account is created on first sign-in using `ADMIN_PASSWORD`. Never commit these values to the repository.

### 2. Deploy

Push to `main`. The GitHub Actions workflow installs dependencies, type-checks, runs tests, provisions the remote D1 database, applies migrations, uploads the admin secret, and deploys the Worker.

## Local development

Requires Node.js 22+.

```bash
npm install
npm run db:reset:local   # create and migrate a local D1 database
npm run dev              # start the local Worker
```

Then open the local Worker URL, enter a name, and start scoring. For the admin view, go to `/admin` and sign in with your local `ADMIN_PASSWORD`.

```bash
npm test          # run the test suite
npm run typecheck
```

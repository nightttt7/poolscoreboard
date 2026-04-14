---
applyTo: 'src/**,migrations/**,.github/workflows/**,README.md'
description: Security and auth rules for poolscoreboard's D1-backed application and deployment flow.
---

## Auth Baseline

- Data-changing routes must require authenticated sessions.
- Prefer also protecting data-reading routes when the data is prototype-private, unless the user explicitly asks for public reads.
- Keep auth database-backed and extensible. Do not replace it with hardcoded in-memory credentials.
- For the pool scoreboard UI, players identify with a display name plus a D1-backed cookie session; do not switch gameplay back to unsigned client-only state.

## Initial Admin Rules

- The initial admin username is fixed as `admin`.
- The initial admin password comes from the deployed Worker secret `ADMIN_PASSWORD`, and from the local `ADMIN_PASSWORD` environment variable during local development.
- For local development, document that `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `ADMIN_PASSWORD` must be configured as local environment variables instead of hardcoding secrets.
- For GitHub Actions deploys, fail fast with a clear error if `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, or `ADMIN_PASSWORD` is missing from Actions secrets.
- For GitHub Actions deploys, ensure the workflow uploads or refreshes the Worker secret before deploying code that depends on it.
- For GitHub Actions deploys, refresh the remote `admin` user's password from `ADMIN_PASSWORD` on every deploy after migrations run.
- The first login path may lazily create the `admin` row from `ADMIN_PASSWORD`, but keep the source of truth in the Worker secret and local environment variable instead of hardcoding credentials.
- If `ADMIN_PASSWORD` changes locally outside GitHub Actions deploys, document that operators must reset the database or update the local `admin` record explicitly.

## Schema Changes

- Auth-related schema changes must preserve a path for bootstrapping a fresh environment from zero.
- Keep migrations readable, but preserve numeric ordering prefixes.
- If auth/session behavior changes, update tests to verify unauthenticated rejection and authenticated success.

## Public Surface Area

- Assume `workers.dev` deployments are publicly reachable.
- Before allowing any browser interaction that mutates D1, verify the route is guarded.
- If a route becomes public by design, document that explicitly instead of leaving it ambiguous.

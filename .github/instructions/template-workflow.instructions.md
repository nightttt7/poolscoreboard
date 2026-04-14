---
applyTo: '**'
description: Project workflow, naming, deployment, and operator-boundary rules for poolscoreboard.
---

## Project Workflow

- Treat this repository as the standalone `poolscoreboard` service, not as a reusable template.
- Preserve the naming convention:
  - Worker name: `poolscoreboard`
  - D1 database name: `poolscoreboard-prod`
- Keep naming-sensitive configuration explicit in source files instead of regenerating it from helper scripts.

## Deployment Reality

- Do not imply that first deploy is fully automatic unless the user has manually configured:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `ADMIN_PASSWORD`
- Deploy automation should fail fast and clearly name any missing required Actions secrets before running Cloudflare commands.
- README updates should present GitHub Actions secrets and local permanent environment variables as the same required credential set on different platforms.
- README updates should clearly separate human-only setup from AI-automatable steps.

## Local Database Workflow

- For local development, prefer Wrangler local D1 backed by persisted SQLite state under `.wrangler/state`.
- When a clean local database is needed, prefer `npm run db:reset:local` instead of inventing ad hoc cleanup steps.
- If changing migrations, keep the numeric filename prefix because migration ordering depends on it.

## Documentation Priority

- Keep README concise and optimized for humans.
- Put irreversible/manual/operator steps first.
- Move detailed development conventions into instruction files rather than bloating README.

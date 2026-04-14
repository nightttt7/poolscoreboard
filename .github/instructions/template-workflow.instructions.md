---
applyTo: '**'
description: Template workflow, naming, deployment, and operator-boundary rules for this Hono + Cloudflare prototype template.
---

## Template Workflow

- This repository is meant to be marked as a GitHub Template Repository and instantiated into new standalone repos.
- Assume the new repo name is the intended project name unless the user explicitly overrides it.
- Preserve the naming convention:
  - Worker name: `[project-name]`
  - D1 database name: `[project-name]-prod`
  - workers.dev URL: `https://[project-name].<workers-dev-subdomain>.workers.dev`
- When editing config or scripts related to naming, keep `npm run sync:project` as the source-of-truth sync mechanism.

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

# Repository Copilot Instructions

- Treat this repository as a reusable template for fast prototypes on Hono + Cloudflare Workers + D1.
- The project name is the single naming source: repo name, folder name, package name, worker name, and workers.dev subdomain should all be `[project-name]`; the D1 name should be `[project-name]-prod`.
- Before changing naming-sensitive files, run or preserve the `sync:project` workflow. Do not hardcode a second competing naming scheme.
- All write operations against app data must remain behind database-backed authentication. Do not re-open public write access to D1-backed routes unless the user explicitly asks for it.
- The initial admin account is `admin`; its initial password comes from the `ADMIN_PASSWORD` Worker secret and local shell environment variables. Do not replace this with a hardcoded password in source.
- Keep the admin bootstrap simple: lazily create the `admin` user during login instead of adding separate migration bootstrap scripts unless the user explicitly asks for them.
- When changing schema, auth, deployment, or template usage, update the relevant instruction files in the same change. Instructions in this repo are expected to evolve continuously with the project.
- Keep README short and human-focused. Put the most emphasis on steps AI cannot complete automatically, especially GitHub secrets, Cloudflare credentials, and local secret files.

# Philosophy

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

# shizue-plot

Repository guide: see [AGENTS.md](AGENTS.md). Chat-export format: `docs/PLATFORM.md`.

## Worktree workflow

The main checkout (this directory) is reserved for the user's live testing. Do
all implementation work in a separate git worktree on a new branch. Read-only
exploration and answering questions may happen in main.

By default one task shares one worktree — when delegating implementation to
subagents, usually have them work inside the worktree the lead created, since
changes scattered across multiple worktrees are tedious to gather. When
parallel tasks are likely to conflict over the same files, per-subagent
isolation is fine at your discretion.

How to get into the worktree: when starting implementation, the lead calls
EnterWorktree to move **its own session** into a new worktree before spawning
subagents — subagents inherit the worktree cwd automatically. Never have a
subagent call EnterWorktree from the repo root; that is rejected by the
harness. For per-subagent isolation, spawn with the Agent tool's
`isolation: "worktree"` instead. Worktrees branch from local HEAD
(`worktree.baseRef: "head"` in `.claude/settings.json`), so uncommitted
changes in main are still not visible — commit first if the task depends on
them. To read main's live state while inside the worktree, use absolute paths
into the main checkout.

Worktree setup:

1. Copy the gitignored env files from the main checkout to the same paths:
   `apps/plot/.env`
2. Run `pnpm install` in the packages you need (fast — pnpm's global store is
   shared). For plot work, also run `pnpm --filter @shizue/core build` once:
   `@shizue/core`'s exports point at its `dist/`, which a fresh worktree doesn't
   have, and without it the web typecheck fails with `TS2307` errors that look
   like broken imports.
3. Run unit tests and typecheck in the worktree as usual. Exception: plot's
   `TEST_DATABASE_URL` is a scratch DB shared with main (TRUNCATEd on every
   test), so never run those tests concurrently with tests running in main.
4. As a rule, don't start dev servers in a worktree — the ports (API 8787,
   web 13000) collide with main's servers. Do live verification in main after
   merging. If you really need one, offset with `API_PORT` and
   `next dev --port <port>`, and if you changed the web port, adjust
   `BETTER_AUTH_URL` to match.

## shizue UI

Before starting any UI work, read @docs/design/shizue-ui.md.

Use the cream, mint and dark-green design system adapted from `../shizue`,
including its store promotion images. The product name is `shizue`; the repository
is `shizue-plot`. All other UI copy goes through the ko/en/ja catalogs.

# shizue-plot

shizue (always lowercase) is a character-chat app one person runs on their own
computer, as RisuAI and PocketRisu are: there are no accounts, and the owner's
ChatGPT plan, connected through the Shizue extension, pays for replies. It
imports RisuAI and SillyTavern cards and plays them as those apps do. The UI is
in Korean, English and Japanese.

This file covers what the code doesn't show: commands, gotchas and the owner's
standing decisions. The docs below own behavior. Read the relevant one before
changing what it describes.

- [apps/plot/docs/ARCHITECTURE.md](apps/plot/docs/ARCHITECTURE.md) is the single
  source of truth for how the product behaves. It is long and in Korean, so
  search it by section. When it doesn't cover a decision, ask the owner instead
  of making one up.
- [apps/plot/docs/OVERVIEW.md](apps/plot/docs/OVERVIEW.md) is the owner's
  plain-language Korean overview of that behavior, with our measured results.
  ARCHITECTURE.md wins where they differ. Update the overview when a change
  alters what it says.
- [docs/PLATFORM.md](docs/PLATFORM.md) defines the exported chat format.
- [docs/design/shizue-ui.md](docs/design/shizue-ui.md) sets the UI direction:
  the cream, mint and dark-green system adapted from the sibling repo
  `../shizue`, including its store promotion images. Read it before any UI work.
- [README.md](README.md) covers setup, testing and migrations in more detail.

## Layout

| Path | Package | Purpose |
|---|---|---|
| `packages/contracts` | `@shizue/contracts` | zod schemas and types for chat export |
| `apps/plot` | `@shizue/plot` | Script aggregator and the unit suite's vitest config |
| `apps/plot/apps/{api,web,e2e}` | `@shizue/api`, `@shizue/web`, `@shizue/e2e` | Hono API, Next app, Playwright tests |
| `apps/plot/packages/{core,db,llm}` | `@shizue/core`, `@shizue/db`, `@shizue/llm` | Cards, prompts and scripts; Drizzle schema and migrations; model adapters |

## Environment and commands

Node 26+ (`.nvmrc`) and pnpm 10.28.2. Nothing else: no Docker. The database is
PGlite (Postgres in WebAssembly) and the files are plain files, both in the
app's folder, `SHIZUE_DATA_DIR` (default `apps/plot/data/app`). `make dev` builds the
libraries, then serves the web app on 13000 and the API on 8787; the API
migrates its database at every start. `make stop` stops the app. Settings live
in `apps/plot/.env`, copied from `.env.example`.

```sh
pnpm install
pnpm --filter @shizue/contracts --filter './apps/plot/packages/*' build
pnpm typecheck
pnpm --filter @shizue/plot exec vitest run apps/web/test/authForm.test.ts
pnpm --filter @shizue/e2e exec playwright test tests/chatgpt.spec.ts
pnpm test
make e2e
```

The second line builds the libraries. Their exports point at `dist/`, which a
fresh checkout lacks. Without it the typecheck fails with TS2307 errors that
look like broken imports. The next two lines run one unit file and one browser
spec. `pnpm test` runs every unit suite. `make e2e` builds the libraries and runs
the whole browser suite.

## Testing

Run the typecheck and the tests your change touches. Run the full `pnpm test`
and `make e2e` for dependency upgrades, cross-cutting changes and releases, and
once at the end of a batch of changes, not after each one. The browser suite is
slow.

Keep regression tests for authentication, security, data integrity and pending
operations. Skip tests for static copy, CSS classes, trivial wrappers, or
behavior another layer already covers.

The suites share nothing, so they may run side by side:

- The API suite runs on an in-memory PGlite of its own, one per test file,
  truncated before every test. The browser suite's API runs on a new empty
  app folder in the system's temp directory, made for each run.
- PGlite opens one folder from one process only (`app.lock`). Never point a
  second process, a maintenance command or a test at a folder an app is
  running on.
- Seed data and hand-test only in a folder of your own (`SHIZUE_DATA_DIR`).
  `apps/plot/data/app` in the main checkout holds the owner's own works, and
  test rows there look like broken imports.
- PGlite's clock counts milliseconds: two rows written in the same millisecond
  share their `created_at`. A test that checks order lets the clock tick first.

The browser suite starts its own API and web app on main's dev ports (8787 and
13000) and the ChatGPT callback port (47801). It refuses to reuse a running
server. In main, run `make stop` first. Outside main, set `E2E_API_URL`,
`E2E_WEB_URL` and `E2E_CALLBACK_PORT` to free ports.

There is no login: a browser on this computer is the owner (ARCHITECTURE §4.1),
so any screen opens as it is. To look at one with data of your own, run the API
with `NODE_ENV=test` on offset ports with a fresh `SHIZUE_DATA_DIR`; test mode
allows the `echo/echo` model. Connecting ChatGPT needs the Shizue browser
extension.

Visual baselines in `apps/plot/apps/e2e/tests/visual.spec.ts-snapshots/` come
in darwin and linux sets. Generate the linux set by running Playwright inside
the `mcr.microsoft.com/playwright` image whose version matches
`@playwright/test`, against an API and web app started on the host.

## Migrations

`pnpm db:generate` writes the next numbered migration into
`apps/plot/packages/db/drizzle/`. Nothing applies it by hand: the app migrates
its folder at every start, the API suite migrates its in-memory database, and
the browser suite's API its fresh folder. Main's dev data takes a new migration
the next time main's app starts, so restart it after landing one.

## Product rules

- An imported RisuAI or SillyTavern card should play as it does in its own app.
  A cap that drops card content is a bug, so raise the cap instead of cutting
  the content. Image and voice generation are out of scope.
- Additions of our own beyond that parity, such as new retrieval, memory or
  ranking, have to show a measured gain on the eval sets. Those live in the main
  checkout's gitignored `apps/plot/data/evals/`. When a simpler mechanism
  covers the same ground, remove the complex one. Parity already brings enough
  complexity.
- Model calls run on the server, so assembled prompts never reach a reader's
  browser.
- UI copy goes through the ko/en/ja catalogs in `apps/plot/apps/web/messages/`.
  The only exception is the product name `shizue`.
- Import chat-export schemas from `@shizue/contracts` rather than redefining
  them. When you change that package, rebuild it and check the API and web
  consumers in the same change.
- Korean documents stay in Korean and English ones in English. A change to
  behavior that ARCHITECTURE.md describes updates that document in the same
  commit.

## Workflow

- The main checkout is the owner's live test environment. Do implementation
  work in a separate git worktree on a new branch. Reading and answering
  questions can happen in main.
- To set up a worktree, copy `apps/plot/.env` from the main checkout, run
  `pnpm install` and build the libraries.
- Do live checks in main after landing. A dev server in a worktree collides
  with main's ports. If you need one, set `API_PORT`, `SHIZUE_WEB_PORT` and a
  matching `BETTER_AUTH_URL` for `scripts/dev.sh`.
- To land, fast-forward `main` to the worktree branch and push. This repo is a
  solo trunk with no pull requests and no CI.
- A commit message is one plain paragraph saying what changed and why, in the
  style of `git log`.
- Wait for long commands such as e2e, builds and servers by their own PID or
  the tool's background-completion notice, with a time limit.
  `pgrep -f <pattern>` also matches other shells waiting on the same pattern,
  so two such loops can wait on each other indefinitely.
- The dev machine has 24 GB shared with other sessions. Run vitest
  with `--maxWorkers=2` and Playwright with `--workers=1`, keep at most one Next
  dev server per agent, and stop servers once the check is done.

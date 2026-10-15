# shizue-plot

shizue (always lowercase) is a hosted character-chat service. Readers sign in
with ChatGPT, the only login, and their own ChatGPT plan pays for replies. It
imports RisuAI and SillyTavern cards and plays them as those apps do. The UI is
in Korean, English and Japanese.

This file covers what the code doesn't show: commands, gotchas and the owner's
standing decisions. The docs below own behavior. Read the relevant one before
changing what it describes.

- [apps/plot/docs/ARCHITECTURE.md](apps/plot/docs/ARCHITECTURE.md) is the single
  source of truth for how the product behaves. It is long and in Korean, so
  search it by section. When it doesn't cover a decision, ask the owner instead
  of making one up.
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

Node 25+ and pnpm 10.28.2. `make dev` starts Docker's PostgreSQL (port 15433)
and RustFS, an S3 stand-in (19000), builds the libraries, then serves the web
app on 13000 and the API on 8787. `make stop` stops the app. Settings live in
`apps/plot/.env`, copied from `.env.example`.

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
spec. `pnpm test` runs every unit suite. `make e2e` starts the containers, builds
the libraries and runs the whole browser suite.

## Testing

Run the typecheck and the tests your change touches. Run the full `pnpm test`
and `make e2e` for dependency upgrades, cross-cutting changes and releases, and
once at the end of a batch of changes, not after each one. The browser suite is
slow.

Keep regression tests for authentication, security, data integrity and pending
operations. Skip tests for static copy, CSS classes, trivial wrappers, or
behavior another layer already covers.

The suites share scratch databases, so plan runs around them:

- The API suite truncates `TEST_DATABASE_URL` before every test. The browser
  suite's API migrates the same database and writes to it. Both refuse a name
  that doesn't end in `_test`. Run only one suite at a time against a given
  scratch database, counting suites in other worktrees.
- `plot_test` is the default. `plot2_test` and up exist for parallel work. To
  use one, point `TEST_DATABASE_URL` in that worktree's own `apps/plot/.env` at
  a free one.
- Seed data and hand-test only on a scratch database. The dev database `plot`
  holds the owner's own works, and test rows there look like broken imports.
- `TEST_S3_REQUIRED=1` makes the S3 tests fail instead of skipping when RustFS
  is down.

The browser suite starts its own API and web app on main's dev ports (8787 and
13000) and the sign-in callback port (47801). It refuses to reuse a running
server. In main, run `make stop` first. Outside main, set `E2E_API_URL`,
`E2E_WEB_URL` and `E2E_CALLBACK_PORT` to free ports.

Sign-in needs the Shizue browser extension. To look at a logged-in screen, run
the API with `NODE_ENV=test` on offset ports against a scratch database. Test
mode allows `POST /api/auth/sign-up/email` and the `echo/echo` model.

Visual baselines in `apps/plot/apps/e2e/tests/visual.spec.ts-snapshots/` come
in darwin and linux sets. Generate the linux set by running Playwright inside
the `mcr.microsoft.com/playwright` image whose version matches
`@playwright/test`, against an API and web app started on the host.

## Migrations

`pnpm db:generate` writes the next numbered migration into
`apps/plot/packages/db/drizzle/`. Before landing one, apply it to the dev
database and to every scratch database. Main's dev server and the next test
run both expect the new schema.

```sh
for db in $(docker compose exec -T postgres psql -U plot -d plot -Atc \
    "select datname from pg_database where datname like 'plot%'"); do
  DATABASE_URL=postgres://plot:plot@localhost:15433/$db pnpm db:migrate
done
```

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
  `pgrep -f <pattern>` also matches other shells waiting on the same pattern.
  Two such loops once waited on each other for hours.
- The dev machine has 24 GB shared with Docker and other sessions. Run vitest
  with `--maxWorkers=2` and Playwright with `--workers=1`, keep at most one Next
  dev server per agent, and stop servers once the check is done.

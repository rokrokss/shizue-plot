# Developing shizue

The code layout, the dev server, the package build, tests, migrations and
operations. Using the app is in the [guide](GUIDE.md).

## Layout

| Path | Purpose |
|---|---|
| `apps/plot/apps/api` | Hono API, the local-owner request gate, chat generation and media storage, and the app's one process (`src/index.ts`, `src/server.ts`) |
| `apps/plot/apps/web` | Next.js character-chat app, served by that process |
| `apps/plot/apps/cli` | The `shizue-plot` package: its command and the build that bundles the app into it |
| `apps/plot/apps/e2e` | Playwright browser tests |
| `apps/plot/packages/core` | Character cards, prompts and chat presentation |
| `apps/plot/packages/db` | Drizzle schema and migrations of the app's PGlite database |
| `apps/plot/packages/llm` | Model request formats, provider adapters and the ChatGPT connection |
| `packages/contracts` | Validated chat-export format |

See [the architecture](../apps/plot/docs/ARCHITECTURE.md) for chat behavior and
[the repository guide](../AGENTS.md) for conventions.

## Development

Node 26+ (`.nvmrc`) and pnpm 10.28.2 are required, and nothing else.

```sh
pnpm install
cp apps/plot/.env.example apps/plot/.env
make dev
```

`make dev` builds the libraries and starts the app's one process on
http://localhost:13000: the API answers `/api/*` and the web app, under
`next dev`, everything else, on both loopbacks (`127.0.0.1` is sent on to
`localhost`). Its data folder is `apps/plot/data/app` unless `SHIZUE_DATA_DIR`
says otherwise, and it reads `apps/plot/.env`. Editing the API restarts the
process; editing the web app reloads the page. `make stop` stops it.
`SHIZUE_PORT` moves it to another port, for a second checkout beside main.

The embedding models the API runs for the chat memory download themselves, as
in the installed app: once the process serves, it fetches the weights it lacks
from Hugging Face in the background — KURE-v1 (738 MB), our int8 conversion at
a pinned commit of `rokrokss/KURE-v1-onnx`, each large file checked against its
SHA-256, and with `EMBEDDER_ROUTING=by-language` also bge-m3 (587 MB) for plots
in other languages (ARCHITECTURE §7.3). `make dev` keeps them in the checkout's
`apps/plot/data/embedder` rather than the data folder, unless `.env` sets
`EMBEDDER_CACHE_DIR`. `pnpm --filter @shizue/api embedder:fetch` downloads them
ahead of time into `EMBEDDER_CACHE_DIR` (else the data folder's `models/`) and
checks they load offline. Until a plot's model is there, its memory picks
recent and random summaries instead of similar ones. Loaded, each model adds
about 2 GB to the process's memory and is unloaded after ten idle minutes;
`EMBEDDER_ROUTING=single EMBEDDER_MODEL=multiMiniLM` runs one light model
(135 MB, about 750 MB loaded), and `EMBEDDER=off` none — which a process started
by hand on a fresh `SHIZUE_DATA_DIR` wants, or it downloads the 738 MB into it.

### The package

`npm pack` in `apps/plot/apps/cli` builds the package first (`scripts/build.mjs`):
the libraries, the web app's production build, and the app's process bundled
with esbuild together with the workspace packages and the threads and children
it starts. Next, React, PGlite, wasmoon and transformers.js stay dependencies.
The memory model is not in the package: the installed app downloads it ([guide](GUIDE.md#install)).
`npm publish` is the owner's to run.

### Card and module imports

The browser uploads a card or module file in 8 MB parts to the API,
which streams each to disk, and a job in the API reads it back and imports it
(ARCHITECTURE §10 파일 임포트). The API reads one import at a time.

## Testing

For a focused change, run the related tests rather than every suite:

```sh
pnpm --filter @shizue/plot exec vitest run apps/web/test/header.test.ts
pnpm --filter @shizue/e2e exec playwright test tests/chatgpt.spec.ts
```

Use the full checks for dependency upgrades, cross-cutting changes, and releases:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
```

The API unit suite runs on an in-memory PGlite of its own and needs no setup.
Browser tests start the app's one process with the test-only echo model
(`NODE_ENV=test`, which the API reads; the web app still runs as `next dev`);
they do not contact an AI provider. It runs on a new empty app folder in the
system's temp directory, never on yours. Every spec is that folder's one owner,
as any browser on this computer is, and tells its own works apart by the run's
unique names. The ChatGPT specs connect through the settings card: one mocks the
API and OpenAI, the other runs the real callback through a stand-in for Shizue.
Stop any normal instance on the test port before running browser tests, or point
`E2E_WEB_URL` and `E2E_CALLBACK_PORT` at free ports; the suite never reuses a
server with a real ChatGPT connection.

## Migrations

The schema starts from one initial migration, `0000_init` in
`apps/plot/packages/db/drizzle/`, which drizzle-kit generated from
`src/schema` and which creates the pgvector extension first. When the schema
changes, `pnpm db:generate` writes the next migration beside it. Nothing applies
them by hand: the app migrates its folder at every start.

## Operations

The app logs to its console. Error tracking is these logs; no external service
is used. Request bodies, cookies, auth headers, prompts and card text are never
logged.

`GET /api/health` answers while the process runs. On Ctrl-C or SIGTERM the app
stops taking connections, stores the replies in flight, waits up to
`SHUTDOWN_BACKGROUND_MS` (20 s) for background work, closes the web app and the
database, gives the folder back and exits, so let a shutdown take over 25
seconds. A chat's generation is held in memory, so no chat is left generating
after a restart. Details are in ARCHITECTURE §12.

# shizue-plot

Character chat with plot creation, character cards, persistent conversations,
branching replies, memory and personas, as an app one person runs on their own
computer. There are no accounts; AI runs on your ChatGPT plan, connected through
Sign in with ChatGPT. The app supports Korean, English and Japanese.

## Layout

| Path | Purpose |
|---|---|
| `apps/plot/apps/api` | Hono API, the local-owner request gate, chat generation and media storage |
| `apps/plot/apps/web` | Next.js character-chat app |
| `apps/plot/apps/e2e` | Playwright browser tests |
| `apps/plot/packages/core` | Character cards, prompts and chat presentation |
| `apps/plot/packages/db` | Drizzle schema and PostgreSQL migrations |
| `apps/plot/packages/llm` | Model adapters and registry |
| `packages/contracts` | Validated chat-export format |

See [the architecture](apps/plot/docs/ARCHITECTURE.md) for chat behavior and
[the repository guide](AGENTS.md) for conventions.

## Quickstart

Node 26+ (`.nvmrc`) and pnpm 10.28.2 are required, and nothing else: the
database is PGlite (PostgreSQL 17 compiled to WebAssembly, with pgvector) and
the files are plain files, both in the app's folder — `SHIZUE_DATA_DIR`,
`apps/plot/data/app` by default. The API migrates the database at every start.

```sh
pnpm install
cp apps/plot/.env.example apps/plot/.env
pnpm --filter @shizue/api embedder:fetch
make dev
```

`embedder:fetch` puts the weights of the embedding models the API runs for the
chat memory into `apps/plot/data/embedder` and checks they load offline:
bge-m3 from Hugging Face (587 MB) and, for Korean plots, KURE-v1 (738 MB) from
the S3 bucket `S3_*` names — the compose RustFS in development, where
`embedder:publish` has to have put our ONNX conversion first (ARCHITECTURE
§7.3). Run it once per checkout: the server never
downloads them itself, and a plot whose model is missing has its memory pick
recent and random summaries instead of similar ones. Loaded, each model adds
about 2 GB to the API's memory and is unloaded after ten idle minutes;
`EMBEDDER_ROUTING=single EMBEDDER_MODEL=multiMiniLM` runs one light model
(135 MB, about 750 MB loaded), and `EMBEDDER=off` none.

Open http://localhost:13000 in Chrome with [Shizue](https://chromewebstore.google.com/detail/mpcbgfkoholfgapcgcmfjobnfcbnfanm) installed (below).
Next.js forwards `/api/*` to Hono on port 8787. `make stop` stops the app
processes. The app's folder persists across restarts; one process at a time may
open it (`app.lock`), so stop the app before running a maintenance command on it.

### Moving from the Postgres setup

A checkout from before 2026-10-18 kept its data in Docker's PostgreSQL and the
RustFS bucket. With those containers still running, copy everything into an
empty app folder once:

```sh
S3_BUCKET=shizue-media S3_ENDPOINT=http://localhost:19000 S3_ACCESS_KEY_ID=shizue \
  S3_SECRET_ACCESS_KEY=shizue-secret S3_FORCE_PATH_STYLE=true \
  pnpm --filter @shizue/api import:postgres -- \
  --from postgres://plot:plot@localhost:15433/plot --uploads ./data/uploads --s3
```

It keeps the old `BETTER_AUTH_SECRET` as the folder's secret, so the ChatGPT
connection still opens, and only reads the source.

### Card and module imports

A reader's browser uploads a card or module file in 8 MB parts to the API,
which streams each to disk, and a job in the API reads it back and imports it
(ARCHITECTURE §10 파일 임포트). The API reads one import at a time.

## The owner, and connecting ChatGPT

shizue runs for one person on their own computer, so there is nothing to sign in
to: a browser on this computer is the app's owner, and so is a phone paired from
the settings page (below). Anything else that reaches the API — a phone through a
tunnel that was never paired, another site's page whose name resolves to this
machine — is answered 401 (ARCHITECTURE §4.1).

Chats run on your own ChatGPT plan, which you connect in **Settings → AI
connection**. Connecting is not a login: it only gives the app your plan. No
provider API key or usage billing is involved; on a limit or connection error the
app reports it and does not switch providers.

OpenAI's open-source flow only returns to `http://127.0.0.1:<port>/auth/callback`.
**Shizue**, the Chrome Web Store extension (0.3.6 or later), rewrites that
navigation to `http://localhost:13000/api/chatgpt/callback` before any connection
is made, on loopback port 47801 (`CHATGPT_CALLBACK_PORT` changes it, for an offset
dev server). It is needed only while connecting; afterwards the API calls OpenAI
directly.

1. Install [Shizue from the Chrome Web Store](https://chromewebstore.google.com/detail/mpcbgfkoholfgapcgcmfjobnfcbnfanm).
2. In **Settings → AI connection**, choose **Continue with ChatGPT** and approve in
   the same tab. The app returns to the settings page.
3. Pick one of your account's models when you start a chat.

The API exchanges the code and keeps the tokens sealed in the app's folder (the
install's `secret` derives the key). **Disconnect ChatGPT** revokes the refresh
token when reachable, deletes the tokens and keeps the app registration for the
next connection; connecting another account replaces the one before. Only this
computer connects or disconnects ChatGPT.

ChatGPT plan sharing supports the Responses route, not image generation or
embeddings: the memory's embeddings come from the model the API runs itself
(above). The images an imported chat carries are sent only when the account's
model catalog advertises image input. Reply length is requested in the prompt;
this route accepts no hard output-token limit.

### On a phone, from your own machine

This needs `BETTER_AUTH_URL` on loopback, as it is by default. Open **Settings → Connect a phone**
and press **Open phone access**: the API opens a tunnel to the web app itself and
shows a QR code, as PocketRisu's remote access does. It uses Tailscale Serve when
this computer is signed in to a tailnet — a fixed address only your devices
reach, with the Tailscale app on the phone, on a port your other `tailscale
serve` entries do not use — and otherwise a Cloudflare Quick Tunnel when
`cloudflared` is installed: no app on the phone, but a public address that
changes each time. Install one of them first (`brew install tailscale` or
`brew install cloudflared`); **Close access** turns it off. A tunnel you run
yourself can be listed in `REMOTE_ORIGINS` (`apps/plot/.env`) instead. Plain LAN
addresses (`http://192.168.x.x`) are not supported: without HTTPS the browser
withholds `crypto.subtle`, `crypto.randomUUID` and the clipboard, which chats use.

Phone browsers run no extension, so a phone never connects ChatGPT itself: it
uses the connection the computer made. Open **Settings → Connect a phone** on the
computer and scan the QR code; the code works once, for five minutes, and the
phone gets a device session of its own for 30 days. **Disconnect this phone** in
the phone's settings ends that session alone. The computer's settings list the
paired phones, with when each was paired and last seen, and disconnect one or all
of them. Disconnecting ChatGPT leaves the phones paired, and closing access keeps
them out.

**Scope.** OpenAI's open-source flow is for open-source and locally hosted apps,
which is what shizue is.

Implementation follows the [official open-source integration guide](https://developers.openai.com/siwc/token-sharing-open-source).
OAuth and provider tests use local stand-ins; a real account must approve the
connection to verify eligibility and actual plan inference.

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
Browser tests serve the API and web app with the test-only echo model
(`NODE_ENV=test` on the API); they do not contact an AI provider. Their API runs
on a new empty app folder in the system's temp directory, never on yours. Every
spec is that folder's one owner, as any browser on this computer is, and tells
its own works apart by the run's unique names. The ChatGPT specs connect through
the settings card: one mocks the API and OpenAI, the other runs the real callback
through a stand-in for Shizue. Stop any normal instance on the test ports before
running browser tests; the suite never reuses a server with a real ChatGPT
connection.

## Migrations

`pnpm db:generate` creates migrations. Nothing applies them by hand: the API
migrates the app's folder at every start. The character-chat schema starts from
a single initial migration, including the pgvector extension; upgrades from the
removed products are unsupported.

## Operations

The API logs to its console. Error tracking is these logs; no external service
is used. Request bodies, cookies, auth headers, prompts and card text are never
logged.

`GET /api/health` answers while the process runs. On SIGTERM the API stops
taking connections, stores the replies in flight, waits up to
`SHUTDOWN_BACKGROUND_MS` (20 s) for background work, closes the database and
exits, so let a shutdown take over 25 seconds. A chat's generation is held in
memory, so no chat is left generating after a restart. Details are in
ARCHITECTURE §12.

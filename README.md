# shizue-plot

Character chat with plot creation, character cards, persistent conversations,
branching replies, memory and personas. AI runs through Sign in with ChatGPT. The app supports Korean,
English and Japanese.

## Layout

| Path | Purpose |
|---|---|
| `apps/plot/apps/api` | Hono API, authentication, chat generation and media storage |
| `apps/plot/apps/web` | Next.js character-chat app |
| `apps/plot/apps/e2e` | Playwright browser tests |
| `apps/plot/packages/core` | Character cards, prompts and chat presentation |
| `apps/plot/packages/db` | Drizzle schema and PostgreSQL migrations |
| `apps/plot/packages/llm` | Model adapters and registry |
| `packages/contracts` | Validated chat-export format |

See [the architecture](apps/plot/docs/ARCHITECTURE.md) for chat behavior and
[the repository guide](AGENTS.md) for conventions.

## Quickstart

Node 25+ and pnpm 10.28.2 are required. Docker provides PostgreSQL 17 with
pgvector and RustFS (an S3-compatible store) for local development.

```sh
pnpm install
cp apps/plot/.env.example apps/plot/.env
pnpm --filter @shizue/api embedder:fetch
make dev
```

`embedder:fetch` downloads the weights of the embedding model the API runs for
the chat memory (135 MB, into `apps/plot/data/embedder`) and checks they load
offline. Run it once per checkout and on every deploy: the server never
downloads them itself, and without them the memory picks recent and random
summaries instead of similar ones. Loaded, the model adds about 750 MB to the
API's memory; `EMBEDDER=off` turns it off.

Open http://localhost:13000 in Chrome with [Shizue](https://chromewebstore.google.com/detail/mpcbgfkoholfgapcgcmfjobnfcbnfanm) installed (below).
Next.js forwards `/api/*` to Hono on port 8787. `make stop` stops the app
processes; `make infra-down` stops the containers. The database and media
volumes persist across restarts.

## Sign in with ChatGPT

Sign in with ChatGPT is the only login, and each reader's own ChatGPT plan runs
their chats. No provider API key or usage billing is involved; on a limit or
connection error the app reports it and does not switch providers.

OpenAI's open-source flow only returns to `http://127.0.0.1:<port>/auth/callback`,
which a hosted site cannot receive. **Shizue**, the Chrome Web Store extension
(0.3.6 or later), rewrites that navigation to the app's `/api/chatgpt/callback`
before any connection is made: `https://plot.shizue.net` on loopback port 47811
and `http://localhost:13000` on 47801, which the API picks from `BETTER_AUTH_URL`.
It is needed only while signing in; afterwards the API calls OpenAI directly.

1. Install [Shizue from the Chrome Web Store](https://chromewebstore.google.com/detail/mpcbgfkoholfgapcgcmfjobnfcbnfanm).
2. Choose **Sign in with ChatGPT** and approve in the same tab. The app returns to
   the page you started from.
3. Pick one of your account's models when you start a chat.

The API exchanges the code, keeps the tokens sealed in the database
(`BETTER_AUTH_SECRET` derives the key; set it in production) and answers each
reader from their own account. Sign-out revokes the refresh token when reachable,
deletes the tokens, keeps the app registration for the next sign-in and ends the
reader's sessions. A former local installation's owner, with its plots and
chats, is taken over by the first account that signs in.

ChatGPT plan sharing supports the Responses route, not image generation or
embeddings: the scene-generation button is disabled, and the memory's embeddings
come from the model the API runs itself (above).
Image attachments are sent only when the account's model catalog advertises image
input. Reply length is requested in the prompt; this route accepts no hard
output-token limit.

**Scope.** OpenAI's open-source flow is for open-source and locally hosted apps.
Holding readers' tokens on a hosted server is the "remotely hosted" case, which
needs OpenAI's [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).
Until that is approved, test only with your own account.

Implementation follows the [official open-source integration guide](https://developers.openai.com/siwc/token-sharing-open-source).
OAuth and provider tests use local stand-ins; a real account must approve sign-in
to verify eligibility and actual plan inference.

## Testing

For a focused change, run the related tests rather than every suite:

```sh
pnpm --filter @shizue/plot exec vitest run apps/web/test/authForm.test.ts
pnpm --filter @shizue/e2e exec playwright test tests/chatgpt.spec.ts
```

Use the full checks for dependency upgrades, cross-cutting changes, and releases:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
```

The API unit suite reads `TEST_DATABASE_URL` from `apps/plot/.env`. It must name
a separate scratch database ending in `_test`; the suite truncates it before
each test. Create and migrate it before the first run:

```sh
docker compose exec -T postgres psql -U plot -d plot -c 'CREATE DATABASE plot_test'
DATABASE_URL=postgres://plot:plot@localhost:15433/plot_test pnpm db:migrate
TEST_S3_REQUIRED=1 pnpm test
```

The S3 tests use the compose RustFS on port 19000. `TEST_S3_REQUIRED=1` makes an unavailable
store fail instead of skip. Browser tests serve the API and web app with the
test-only echo model (`NODE_ENV=test` on the API); they do not contact an AI
provider. Their API runs on the same scratch `TEST_DATABASE_URL`, which it migrates
on start, never on the app's `DATABASE_URL`; since `pnpm test` truncates that
database, don't run the two at once. Legacy email/password sessions exist only in this test mode to isolate
test fixtures; the normal app does not serve those endpoints. The ChatGPT login
spec mocks OAuth to exercise the single-button entrance and automatic redirect.
Stop any normal instance on the test ports before running browser tests; the suite
never reuses a server with a real account connection.

## Migrations

`pnpm db:generate` creates migrations; `pnpm db:migrate` applies them to
`DATABASE_URL`. The character-chat schema starts from a single initial migration,
including the pgvector extension. Existing databases must be reset before applying
it; upgrades from the removed products are unsupported.

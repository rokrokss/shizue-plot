# shizue guide

How to install shizue, where it keeps your data, and how it connects to models.
The [README](../README.md) is the short version; development is in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Install

Node.js 26 or newer is all it needs — no Docker, no database to set up:

```sh
npx shizue-plot
```

The app starts on http://localhost:13000 and opens it in your browser. Ctrl-C
stops it. `--no-open` leaves the browser alone, and `--port <n>` answers on
another port; but ChatGPT sign-in comes back to port 13000 only (below), so on
another port connect models with API keys. A port another program holds is
refused rather than shared: stop that program, or pick another port. Node 26 is
needed because cards' Lua scripts run in a sandbox built on Node's permission
model.

npm 11.20 and newer may warn that 3 packages have install scripts not yet
covered by `allowScripts` (`onnxruntime-node`, `sharp` and `protobufjs`) and
suggest `npm install-scripts approve`. The warning is expected and nothing needs
approving: the app needs none of those scripts — onnxruntime's native bindings
ship inside its package, and its script only fetches CUDA files for Linux x64.

On its first start the app also downloads its memory model, KURE-v1 (about
740 MB), from Hugging Face into the data folder's `models/`. That happens in the
background while the app already serves, and the log shows how far it is; a
download cut short resumes on the next start. Until the model is there, a
chat's memory picks recent and random summaries instead of similar ones and
notes no facts, and the chat's memory panel says so.

### The data folder

Everything the app has is in one folder: the database (`db/`, PGlite —
PostgreSQL 17 compiled to WebAssembly, with pgvector), the files (`files/`:
avatars, card assets, attachments, covers, imports), the install's `secret`
(0600: it seals your ChatGPT tokens and API keys), `models/` for the
embedding model's weights, and `bin/` for the cloudflared the phone's tunnel
downloads when it needs one. The installed app keeps it where the system keeps an
app's data:

| System | Folder |
|---|---|
| macOS | `~/Library/Application Support/shizue-plot` |
| Windows | `%APPDATA%\shizue-plot` |
| Linux | `$XDG_DATA_HOME/shizue-plot`, or `~/.local/share/shizue-plot` |

`SHIZUE_DATA_DIR` names another. The app migrates the database at every start,
and only one process opens a folder at a time (`app.lock`): a second start while
the app runs is refused.

### Backup and restore

Settings › Backup and restore downloads the whole folder as one `.tar` file,
made while the app runs: the database (PGlite's own dump, taken in one
transaction), every file in `files/`, and a manifest with each table's row
count and the hashes a restore checks. It leaves out the install's `secret`, so
the file alone opens none of your API keys or ChatGPT tokens, and `models/`
and `bin/`, which download again.

A restore, from the computer the app runs on only, checks the file and unpacks
it into a new folder beside the current one (`<folder>.restore-…`); anything
that is not a whole shizue backup this version can open is refused and the new
folder deleted. The database is opened there, its row counts checked, and
migrated to this version. This install's `secret` is copied in, so a backup
made on this computer opens its keys and ChatGPT connection as before; restored
on another computer, enter the API keys and connect ChatGPT again. The switch
happens at the next start: quit the app and start it again. The folder from
before is kept beside the new one (`<folder>.before-restore-…`) until you delete
it, and if the restored database does not open, the app goes back to it.

RisuAI's `.bin` backups are not read: bring RisuAI characters over as card
files, presets and modules as their files, and chats as below.

### Chat files

A work's chat list (in its studio page) imports a RisuAI chat — its JSON
export of one chat or of all a character's chats, older `risuChat` and
`risuAllChats` files, or its HTML export — or a SillyTavern `.jsonl` chat, and
exports each chat as RisuAI does: JSON that RisuAI and shizue read back, text,
or HTML, and every chat of the work as one JSON file. A RisuAI chat opens on the
work's own greeting that its `fmIndex` names, as it does in RisuAI. The app's
own export format (`docs/PLATFORM.md`) is unchanged.

## The owner, and the models

shizue runs for one person on their own computer, so there is nothing to sign in
to: a browser on this computer is the app's owner, and so is a phone paired from
the settings page (below). Anything else that reaches the API — a phone through a
tunnel that was never paired, another site's page whose name resolves to this
machine — is answered 401 (ARCHITECTURE §4.1).

Chats run on model presets, as in PocketRisu. A preset names a request format,
a model, a key or a keyless address, and the values sent with it (temperature,
reasoning effort and the rest); make them in **Settings → Models**. Each chat
binds a main model for its replies and a sub model for the side work: scripts'
model calls, summaries, facts, reply suggestions, translation, emotions and lore
aliases. A chat that picks none follows the default models on the same page, and
with no sub model the main one does the side work. On a limit or connection
error the app reports it and does not switch to another preset (ARCHITECTURE
§7.1).

**Add preset** opens PocketRisu's model registry: a curated profile per model,
grouped by provider and searchable, for Google AI Studio, Anthropic, OpenAI,
OpenRouter, DeepSeek, DeepInfra, NanoGPT and Ollama Cloud keys. A profile says
which values the model takes, their ranges and defaults, its reply cap (thinking
included: 8,192 tokens for Gemini 3.8 Flash, 32,768 for Gemini 4 Argon), its
context window and its status; older and retired models are hidden until you
ask for them. A preset on a profile sends only the profile's fields, as
PocketRisu does, retries a request that fails before the reply begins twice,
and shows **Update available** when the registry revises its profile. The app
carries a copy of the registry and refreshes it from PocketRisu's own
(`MODEL_REGISTRY_URL` in `.env.example` names another or turns it off); what it
fetches is checked before it is kept, and a key still goes only to its own
address, whatever a profile names. The **Custom** tab is the preset editor for
everything else — your ChatGPT plan, local servers, Bedrock, Vertex AI, Mistral,
Cohere, NovelAI, NovelList, AI Horde, and models the registry does not list —
where you pick a format and type or load the model ID.

Every request format RisuAI has is here but WebLLM and Plugin, which run inside
RisuAI's own page, and its Echo:

| Request format | For |
|---|---|
| OpenAI-compatible (Chat Completions) | OpenAI, OpenRouter, DeepSeek, DeepInfra, Mistral and NanoGPT keys, any compatible server, and keyless local servers such as LM Studio, Ollama's `/v1`, llama.cpp or vLLM |
| OpenAI Responses | OpenAI and NanoGPT keys, and your ChatGPT plan |
| Anthropic Messages | Anthropic and NanoGPT keys |
| Google AI Studio (Gemini) | Google AI Studio keys |
| Google Vertex AI (Gemini) | A Google Cloud service account's JSON key, and its region |
| AWS Bedrock (Claude) | AWS access keys (a session token too, for temporary ones), and their region |
| Mistral | Mistral keys, with RisuAI's turn rules for Mistral |
| Cohere | Cohere keys (the v1 chat API) |
| Ollama (native API) | Ollama on this computer, keyless, or Ollama Cloud's key |
| text-generation-webui, and its legacy API | A local text-generation-webui, or Mancer's key on the legacy one |
| KoboldAI / KoboldCpp | A local Kobold server (KoboldCpp's stream where it has one) |
| NovelAI | A NovelAI persistent API token |
| NovelList (AI Novelist) | NovelList keys |
| AI Horde | Anyone (the anonymous key), or your Horde key |
| OpenAI legacy completions | OpenAI and NanoGPT keys, for completion models such as `gpt-3.5-turbo-instruct` |
| Anthropic legacy text completions | Anthropic keys, for the retired Text Completions API (RisuAI's prompt until 2024) |

The text formats (text-generation-webui, Kobold, Horde) write the chat as one
prompt through an instruct template the preset picks, RisuAI's built-ins
(ChatML by default, Llama 3, Llama 2, Gemma, Mistral, Vicuna, Alpaca) or your
own Jinja; NovelAI and NovelList get RisuAI's own transcripts of the chat.

### API keys

Add keys in **Settings → API keys**, on the computer shizue runs on; a paired
phone only lists them. The API seals each key in the app's folder (the install's
`secret` derives the key), never returns it — the page shows a masked hint — and
sends it only to the address it was entered for: the provider's own, or the one
you typed for a custom server. **Check** asks the provider whether the key
works. Saving a key while you have no model preset makes one and makes it the
default: on the provider's first current registry profile where the registry
has the provider, otherwise on a chat model the provider lists (a mini or
Sonnet-class one where it has one, never an embedding or completions-only
model). A preset picks
the key, and **Load the model list** fetches the provider's models for it. A
server that needs no key gets its address in the preset instead, and no key is
ever sent there. AWS keys go only to their region's Bedrock, and a service
account only to its project's Vertex AI and Google's token endpoint.

### Your ChatGPT plan

Connecting ChatGPT is not a login: it only gives the app your plan, and no API
key or usage billing is involved.

OpenAI's open-source flow only returns to `http://127.0.0.1:<port>/auth/callback`.
**Shizue**, the Chrome Web Store extension (0.3.6 or later), rewrites that
navigation to `http://localhost:13000/api/chatgpt/callback` before any connection
is made, on loopback port 47801 (`CHATGPT_CALLBACK_PORT` changes it, for an offset
dev server). It is needed only while connecting; afterwards the API calls OpenAI
directly. That is why the app answers on port 13000, and why ChatGPT is
connected from Chrome (or another Chromium) with the extension installed.

1. Install [Shizue from the Chrome Web Store](https://chromewebstore.google.com/detail/mpcbgfkoholfgapcgcmfjobnfcbnfanm).
2. In **Settings → ChatGPT connection**, choose **Continue with ChatGPT** and
   approve in the same tab. The app returns to the settings page.
3. With no model preset yet, the connection makes one on your account's first
   model and makes it the default. Add others in **Settings → Models** with the
   OpenAI Responses format and **ChatGPT plan** as their key. An install that had
   chats before model presets existed already has one preset for each model its
   chats used.

The API exchanges the code and keeps the tokens sealed in the app's folder (the
install's `secret` derives the key). **Disconnect ChatGPT** revokes the refresh
token when reachable, deletes the tokens and keeps the app registration for the
next connection; connecting another account replaces the one before, and the
presets on the plan run on the new account. Only this
computer connects or disconnects ChatGPT.

ChatGPT plan sharing supports the Responses route, not image generation or
embeddings: the memory's embeddings come from the model the API runs itself
(above). The images an imported chat carries are sent only when the account's
model catalog advertises image input. Reply length is requested in the prompt;
this route accepts no hard output-token limit.

### On a phone, from your own machine

Open **Settings → Connect a phone** and press **Open phone access**: the app
opens a tunnel to itself and shows a QR code, as PocketRisu's remote access
does. It uses Tailscale Serve when this computer is signed in to a tailnet — a
fixed address only your devices reach, with the Tailscale app on the phone, on a
port your other `tailscale serve` entries do not use — and otherwise a
Cloudflare Quick Tunnel through `cloudflared`: no app on the phone, but a
public address that changes each time. With neither installed, the button
downloads cloudflared itself, as PocketRisu's does: Cloudflare's official
GitHub release for this computer (macOS arm64 or x64, Linux amd64 or arm64,
Windows amd64), pinned to one version and its SHA-256, into `bin/` in the app's
folder, and checked again before every start: a file there that does not match
is deleted, never run. Elsewhere, install one of them first
(`brew install tailscale` or `brew install cloudflared`). **Close access** turns
it off. A tunnel you run yourself can be listed in `REMOTE_ORIGINS` instead.
Plain LAN addresses (`http://192.168.x.x`) are not supported: without HTTPS the
browser withholds `crypto.subtle`, `crypto.randomUUID` and the clipboard, which
chats use.

Phone browsers run no extension, so a phone never connects ChatGPT or adds keys
itself: it uses the connection and keys the computer made. Open **Settings → Connect a phone** on the
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

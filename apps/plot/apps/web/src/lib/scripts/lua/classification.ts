/**
 * Where each of RisuAI's Lua functions is carried out here — every name its
 * `runScripted` declares, the helpers its wrapper defines over them, and the
 * hooks it calls into a script — in `TRIGGER_CLASSIFICATION`'s words:
 *
 * - `browser`: done in the reader's browser, as RisuAI does it — in the sandbox,
 *   or for `similarity` and `loadLoreBooks`, on the page, which the sandbox
 *   relays the call to.
 * - `server`: done in the sandbox, and what it changed is carried to the API
 *   the way a trigger's writes are — a chat variable on the turn, the chat the
 *   run left, a rewrite of the work in the chat's overlay — or, for a model
 *   call, answered by the API on the reader's own account, and for a request,
 *   made by the API, as RisuAI's proxy makes it.
 * - `logged`: answers what RisuAI answers when there is nothing to act on, and
 *   the run notes it.
 * - `impossible`: nothing here can do it; logged, with RisuAI's failure value.
 *
 * Kept as data so a test holds the sandbox to it: every function the worker
 * declares is named here, and every declared name here is one the worker or the
 * wrapper defines. `lowLevelAccess` marks the ones RisuAI keeps behind the
 * card's low-level access, which is kept here too.
 */

import type { TriggerSupport } from '@shizue/core/triggers';

export interface LuaSupport {
  support: TriggerSupport;
  /** What kind of name it is: a function the worker declares, a wrapper helper, or a hook RisuAI calls. */
  kind: 'host' | 'wrapper' | 'hook';
  lowLevelAccess?: true;
  note: string;
}

const host = (support: TriggerSupport, note = '', lowLevelAccess = false): LuaSupport => ({
  support,
  kind: 'host',
  note,
  ...(lowLevelAccess ? { lowLevelAccess: true as const } : {}),
});
const wrapper = (support: TriggerSupport, note = ''): LuaSupport => ({ support, kind: 'wrapper', note });
const hook = (support: TriggerSupport, note = ''): LuaSupport => ({ support, kind: 'hook', note });

export const LUA_CLASSIFICATION: Readonly<Record<string, LuaSupport>> = {
  // Variables
  getChatVar: host('browser'),
  setChatVar: host('server', 'the turn’s variable delta; a display pass’s writes stay on the screen'),
  setChatVarChanged: host('server', 'as setChatVar'),
  getGlobalVar: host('browser', 'the reader’s global variables on the plot (RisuAI’s Lua has no setter)'),
  getState: wrapper('browser', 'chat variable `__name`, JSON'),
  setState: wrapper('server', 'as setChatVar'),
  setStateChanged: wrapper('server', 'as setChatVarChanged'),

  // Control and dialogs
  stopChat: host('browser', 'start/input runs: the generation is not sent'),
  alertNormal: host('browser', 'ScriptDialog; the script does not wait, as in RisuAI'),
  alertError: host('browser', 'as alertNormal'),
  alertInput: host('browser', 'ScriptDialog'),
  alertSelect: host('browser', 'ScriptDialog'),
  alertConfirm: host('browser', 'ScriptDialog'),
  sleep: host('browser', 'capped at 30s a call'),
  reloadDisplay: host('browser', 'nothing to do: the chat redraws from state'),
  reloadChat: host('browser', 'nothing to do: the chat redraws from state'),
  log: wrapper('browser', 'the sandbox’s console'),
  logMain: host('browser', 'the sandbox’s console'),

  // The chat
  getChat: wrapper('browser'),
  getChatMain: host('browser'),
  getChatData: host('browser'),
  getChatRole: host('browser'),
  getChatLength: host('browser'),
  getFullChat: wrapper('browser'),
  getFullChatMain: host('browser'),
  getRecentChats: wrapper('browser'),
  getRecentChatsMain: host('browser'),
  getCharacterLastMessage: host('browser', 'else the greeting the branch opened on'),
  getUserLastMessage: host('browser'),
  setChat: host(
    'server',
    'any message: the head in place while nothing hangs under it, any other on a new branch (ScriptChat); an edit listener’s is dropped',
  ),
  setChatRole: host('server', 'as setChat'),
  setFullChat: wrapper('server', 'as setFullChatMain'),
  setFullChatMain: host('server', 'the whole chat; a message stays itself where its place and role did not change, as setChat'),
  cutChat: host('server', 'as setChat; what it cuts stays in the tree as another branch'),
  removeChat: host('server', 'as cutChat'),
  addChat: host('server', 'appended to the chat the run leaves, kept as the reader’s branch'),
  insertChat: host('server', 'as addChat, at its place'),
  getTokens: host('browser', 'estimated, four characters a token'),
  cbs: host('browser', 'only {{char}}, {{user}}, {{getvar}}, {{getglobalvar}}; the rest is left as written'),

  // The character, the persona, the note
  getName: host(
    'browser',
    'RisuAI’s `char.name`: the member’s name as this chat’s overlay has it (`{{char}}` is the nickname, where the card sets one)',
  ),
  setName: host(
    'server',
    'chat overlay: the member’s name in this chat — its speaker name (its lines under the old one stay its), the name the prompt gives it, `{{char}}` where the card has no nickname, and the plot’s `{{char}}` in a plot of one member; one line of at most 100 characters, else dropped and noted',
  ),
  getDescription: host('browser', 'the description as this chat’s overlay has it'),
  setDescription: host('server', 'chat overlay'),
  getCharacterFirstMessage: host('browser', 'what setCharacterFirstMessage left, else the greeting the branch opened on'),
  setCharacterFirstMessage: host(
    'server',
    'chat overlay: what the plot’s first opening reads as, on screen and in the prompt, while the branch opens on it (RisuAI’s `fmIndex` -1); the stored greeting stays; answers true',
  ),
  getPersonaName: host('browser'),
  getPersonaDescription: host('browser', 'its {{char}}/{{user}}/variables answered as cbs() answers them'),
  getAuthorsNote: host('browser', 'the chat note'),
  getBackgroundEmbedding: host('browser', 'the overlay’s, else the card’s `backgroundHTML`, whole'),
  setBackgroundEmbedding: host(
    'server',
    'chat overlay: drawn behind the conversation as CBS through the display sanitizer, scoped to it, in place of the card’s; answers true',
  ),
  getLoreBooks: wrapper('browser', 'by name, in RisuAI’s shape; content as cbs() answers it'),
  getLoreBooksMain: host('browser', 'as getLoreBooks'),
  upsertLocalLoreBook: host('server', 'chat overlay; replaces the entries of that name'),
  loadLoreBooks: wrapper(
    'browser',
    'activated on the page as /test_lorebook is — the member’s book with the call’s upserts, over the chat as the script has it — and cut at the chat’s context budget less `reserve`; content as cbs() answers it',
  ),
  loadLoreBooksMain: host('browser', 'as loadLoreBooks', true),
  getCharacterImage: wrapper(
    'browser',
    'the member’s avatar as the markup RisuAI’s inlay token draws (`<div class="risu-inlay-image"><img>`), which a message or the display draws here; the model reads it as text; empty without one',
  ),
  getCharacterImageMain: host('browser', 'as getCharacterImage'),
  getPersonaImage: wrapper('browser', 'a persona has no picture here: empty, RisuAI’s answer for one without'),
  getPersonaImageMain: host('browser', 'as getPersonaImage'),

  // Model, network, images
  LLM: wrapper('server', 'POST /api/chats/:id/script-llm, the chat’s model on the reader’s account; text only'),
  LLMMain: host('server', 'as LLM', true),
  axLLM: wrapper('server', 'as LLM, on the chat’s auxiliary model; every auxiliary mode shares it'),
  axLLMMain: host('server', 'as axLLM', true),
  simpleLLM: host('server', 'as LLM', true),
  similarity: host(
    'browser',
    'RisuAI’s default embedder (Xenova/all-MiniLM-L6-v2, q8) in the page’s worker, shared with the triggers; best first, as RisuAI orders them; a failure is a Lua error',
    true,
  ),
  request: host(
    'server',
    'POST /api/chats/:id/script-fetch: our server makes the GET, as RisuAI’s proxy does on the web, so the address sees our server, not the reader; RisuAI’s limits and answers (six a minute per reader, 120 characters, https, its banned hosts and ours); only public addresses, redirects re-checked, 10s, 2MB',
    true,
  ),
  generateImage: host('impossible', 'answers RisuAI’s failure text', true),
  hash: host('browser', 'SHA-256, hex'),

  // The wrapper's machinery
  json: wrapper('browser', 'rxi’s json.lua interface'),
  async: wrapper('browser'),
  listenEdit: wrapper('browser', 'editInput, editOutput, editDisplay; editRequest never fires (the prompt is built on the server)'),
  callListenMain: wrapper('browser'),

  // Hooks RisuAI calls
  onStart: hook('server', 'before every generation'),
  onInput: hook('server', 'before a send'),
  onOutput: hook('server', 'after a reply; committed with script-commit'),
  onButtonClick: hook('server', 'risu-btn; committed on the head'),
  'manual:<name>': hook('server', 'a manual run by name (risu-trigger, {{button}}, runtrigger) calls the global of that name'),
  'listen:editInput': hook('server', 'the text a send goes as'),
  'listen:editOutput': hook('server', 'the reply as it is stored'),
  'listen:editDisplay': hook('browser', 'the screen only, before the display triggers'),
  'listen:editRequest': hook('impossible', 'the request is assembled on the server'),
};

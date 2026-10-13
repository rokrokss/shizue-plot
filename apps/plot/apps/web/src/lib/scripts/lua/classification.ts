/**
 * Where each of RisuAI's Lua functions is carried out here — every name its
 * `runScripted` declares, the helpers its wrapper defines over them, and the
 * hooks it calls into a script — in `TRIGGER_CLASSIFICATION`'s words:
 *
 * - `browser`: done in the sandbox, as RisuAI does it.
 * - `server`: done in the sandbox, and what it changed is carried to the API
 *   the way a trigger's writes are — a chat variable on the turn, the head's
 *   text in place, a rewrite of the work in the chat's overlay — or, for a model
 *   call, answered by the API on the reader's own account.
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
  setChat: host('server', 'the head is rewritten in place; other messages are not'),
  setChatRole: host('logged', 'seen by the script; a stored message keeps its role'),
  setFullChat: wrapper('server', 'as setChat'),
  setFullChatMain: host('server', 'as setChat'),
  cutChat: host('logged', 'seen by the script; the tree is append-only'),
  removeChat: host('logged', 'seen by the script; the tree is append-only'),
  addChat: host('logged', 'seen by the script; nothing appends a message without a generation'),
  insertChat: host('logged', 'as addChat'),
  getTokens: host('browser', 'estimated, four characters a token'),
  cbs: host('browser', 'only {{char}}, {{user}}, {{getvar}}, {{getglobalvar}}; the rest is left as written'),

  // The character, the persona, the note
  getName: host('browser', '`{{char}}`: the member’s nickname, else its name'),
  setName: host('logged', 'the name is the plot’s'),
  getDescription: host('browser', 'the description as this chat’s overlay has it'),
  setDescription: host('server', 'chat overlay'),
  getCharacterFirstMessage: host('browser', 'the greeting the branch opened on'),
  setCharacterFirstMessage: host('logged', 'the greeting is a stored message; answers false'),
  getPersonaName: host('browser'),
  getPersonaDescription: host('browser', 'its {{char}}/{{user}}/variables answered as cbs() answers them'),
  getAuthorsNote: host('browser', 'the chat note'),
  getBackgroundEmbedding: host('logged', 'there is no background HTML; answers an empty string'),
  setBackgroundEmbedding: host('logged', 'answers false'),
  getLoreBooks: wrapper('browser', 'by name, in RisuAI’s shape; content as cbs() answers it'),
  getLoreBooksMain: host('browser', 'as getLoreBooks'),
  upsertLocalLoreBook: host('server', 'chat overlay; replaces the entries of that name'),
  loadLoreBooks: wrapper('impossible', 'lore is activated on the server; answers an empty list'),
  loadLoreBooksMain: host('impossible', 'as loadLoreBooks', true),
  getCharacterImage: wrapper('impossible', 'there are no inlay images; answers an empty string'),
  getCharacterImageMain: host('impossible', 'as getCharacterImage'),
  getPersonaImage: wrapper('impossible', 'as getCharacterImage'),
  getPersonaImageMain: host('impossible', 'as getCharacterImage'),

  // Model, network, images
  LLM: wrapper('server', 'POST /api/chats/:id/script-llm, the chat’s model on the reader’s account; text only'),
  LLMMain: host('server', 'as LLM', true),
  axLLM: wrapper('server', 'as LLM, on the chat’s auxiliary model; every auxiliary mode shares it'),
  axLLMMain: host('server', 'as axLLM', true),
  simpleLLM: host('server', 'as LLM', true),
  similarity: host('impossible', 'no embedder; answers an empty list', true),
  request: host('impossible', 'the sandbox has no network; answers RisuAI’s refusal (status 400)', true),
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

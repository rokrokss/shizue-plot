/**
 * Where each of RisuAI's trigger conditions and effects is carried out here.
 *
 * - `browser`: the interpreter does it, in the reader's browser, as RisuAI does.
 * - `server`: the interpreter does it, and the runtime hands the result to the
 *   API to keep — a variable on the turn, prompt text on the generation, the
 *   chat the run left (`ScriptChat`), a rewrite of the work in the chat's
 *   overlay, the reader's note.
 * - `logged`: the run notes it and goes on, leaving what RisuAI leaves when the
 *   effect finds nothing to act on.
 * - `impossible`: nothing here can do it (no image provider, the prompt never
 *   reaches the browser); logged, with RisuAI's failure value written where it
 *   writes one.
 *
 * Kept as data so the tests can hold the interpreter to it: every effect it
 * names here is one the interpreter has a case for.
 */

export type TriggerSupport = 'browser' | 'server' | 'logged' | 'impossible';

export const TRIGGER_CLASSIFICATION: Readonly<Record<string, { support: TriggerSupport; note: string }>> = {
  // Conditions (v1)
  'condition:var': { support: 'browser', note: 'chat variable compared after CBS' },
  'condition:value': { support: 'browser', note: 'literal compared after CBS' },
  'condition:chatindex': { support: 'browser', note: 'messages after the greeting; the whole branch is loaded first' },
  'condition:exists': { support: 'browser', note: 'strict / loose / regex over the last N messages' },

  // Modes
  'mode:start': { support: 'server', note: 'before every generation; writes ride as startDelta / variableDelta, prompt text as injections' },
  'mode:input': { support: 'server', note: 'before a send; writes ride on the user turn' },
  'mode:output': { support: 'server', note: 'after a reply; committed with script-commit' },
  'mode:manual': { support: 'server', note: 'buttons and runtrigger; committed on the head' },
  'mode:display': { support: 'browser', note: 'per message as it is drawn; never stored' },
  'mode:request': { support: 'impossible', note: 'the request is assembled on the server' },

  // v1 effects
  setvar: { support: 'server', note: '' },
  systemprompt: { support: 'server', note: 'start runs only: prompt injections' },
  impersonate: { support: 'server', note: 'appended to the chat the run leaves, which is kept as the reader’s branch (`ScriptChat`)' },
  command: {
    support: 'server',
    note:
      'RisuAI’s slash commands (`command.ts`), on the chat as stored: the run’s own chat is written back over what they did, ' +
      'except the variables of an input run that changed none itself, and all of it when the run ends early; ' +
      '/multisend never generates in a run; /speak is silent (an imported card has no TTS)',
  },
  stop: {
    support: 'browser',
    note: 'start run: the generation is not sent (a send keeps its text in the composer); what the run did to the rest of the chat is kept',
  },
  runtrigger: { support: 'browser', note: 'nesting capped at 10 unless lowLevelAccess, 50 always' },
  cutchat: { support: 'server', note: '`chat.message.slice(start, end)`; what it cuts stays in the tree as another branch' },
  modifychat: {
    support: 'server',
    note: 'any message: the head in place while nothing hangs under it, any other on a new branch that copies the rest',
  },
  showAlert: { support: 'browser', note: 'lowLevelAccess' },
  sendAIprompt: { support: 'server', note: 'lowLevelAccess; an automatic next turn, with the reader’s consent' },
  runLLM: { support: 'server', note: 'lowLevelAccess; POST /api/chats/:id/script-llm on the chat’s model; a failure writes “Error: …”' },
  runAxLLM: { support: 'logged', note: 'declared but never handled by RisuAI, so it does nothing' },
  checkSimilarity: {
    support: 'browser',
    note:
      'lowLevelAccess; RisuAI’s default embedder (Xenova/all-MiniLM-L6-v2, q8, transformers.js) in a worker the page starts; ' +
      'value split on §, ordered as RisuAI orders them, joined with §; a failure stops the run, as RisuAI’s throw does',
  },
  extractRegex: { support: 'browser', note: 'lowLevelAccess' },
  runImgGen: { support: 'impossible', note: 'lowLevelAccess; writes RisuAI’s failure text' },
  triggerlua: {
    support: 'server',
    note: 'the Lua engine, sandboxed in the reader’s browser; what the code writes rides like any effect’s (LUA_CLASSIFICATION in the web app)',
  },
  triggercode: { support: 'logged', note: 'never run by RisuAI either' },

  // v2 control flow and variables
  v2Header: { support: 'browser', note: '' },
  v2Comment: { support: 'browser', note: '' },
  v2If: { support: 'browser', note: '' },
  v2IfAdvanced: { support: 'browser', note: '' },
  v2Else: { support: 'browser', note: '' },
  v2EndIndent: { support: 'browser', note: '' },
  v2Loop: { support: 'browser', note: 'bounded by the run’s step limit' },
  v2LoopNTimes: { support: 'browser', note: '' },
  v2BreakLoop: { support: 'browser', note: '' },
  v2StopTrigger: { support: 'browser', note: '' },
  v2RunTrigger: { support: 'browser', note: '' },
  v2ConsoleLog: { support: 'browser', note: '' },
  v2SetVar: { support: 'server', note: '' },
  v2DeclareLocalVar: { support: 'browser', note: '' },
  v2Random: { support: 'browser', note: '' },
  v2Calculate: { support: 'browser', note: 'RisuAI’s calcString, ported' },
  v2Wait: { support: 'browser', note: 'capped at 30s' },
  v2UpdateGUI: { support: 'browser', note: 'nothing to do: the chat redraws from state' },
  v2UpdateChatAt: { support: 'browser', note: 'nothing to do: the chat redraws from state' },
  v2Tokenize: { support: 'browser', note: 'estimated, four characters a token' },

  // v2 chat
  v2CutChat: { support: 'server', note: 'as cutchat; an unreadable start is 0 and end the length' },
  v2ModifyChat: { support: 'server', note: 'as modifychat' },
  v2SystemPrompt: { support: 'server', note: 'start runs only: prompt injections' },
  v2Impersonate: { support: 'server', note: 'as impersonate' },
  v2Command: { support: 'server', note: 'as command' },
  v2SendAIprompt: { support: 'server', note: 'lowLevelAccess; an automatic next turn, with the reader’s consent' },
  v2StopPromptSending: { support: 'browser', note: 'as stop' },
  v2GetLastMessage: { support: 'browser', note: '' },
  v2GetMessageAtIndex: { support: 'browser', note: '' },
  v2GetMessageCount: { support: 'browser', note: '' },
  v2GetLastUserMessage: { support: 'browser', note: '' },
  v2GetLastCharMessage: { support: 'browser', note: '' },
  v2GetFirstMessage: { support: 'browser', note: 'the greeting the branch opened on' },
  v2QuickSearchChat: { support: 'browser', note: '' },

  // v2 model, images, embeddings
  v2ImgGen: { support: 'impossible', note: 'lowLevelAccess; writes null' },
  v2CheckSimilarity: { support: 'browser', note: 'as checkSimilarity; the output variable’s name goes through CBS' },
  v2RunLLM: { support: 'server', note: 'lowLevelAccess; POST /api/chats/:id/script-llm (`submodel` is the chat’s auxiliary model); a failure writes null' },

  // v2 dialogs and display
  v2ShowAlert: { support: 'browser', note: '' },
  v2GetAlertInput: { support: 'browser', note: '' },
  v2GetAlertSelect: { support: 'browser', note: '' },
  v2GetDisplayState: { support: 'browser', note: 'display runs' },
  v2SetDisplayState: { support: 'browser', note: 'display runs' },
  v2GetRequestState: { support: 'impossible', note: 'request mode' },
  v2SetRequestState: { support: 'impossible', note: 'request mode' },
  v2GetRequestStateRole: { support: 'impossible', note: 'request mode' },
  v2SetRequestStateRole: { support: 'impossible', note: 'request mode' },
  v2GetRequestStateLength: { support: 'impossible', note: 'request mode' },

  // v2 strings
  v2ExtractRegex: { support: 'browser', note: '' },
  v2RegexTest: { support: 'browser', note: '' },
  v2ReplaceString: { support: 'browser', note: '' },
  v2GetCharAt: { support: 'browser', note: '' },
  v2GetCharCount: { support: 'browser', note: '' },
  v2ToLowerCase: { support: 'browser', note: '' },
  v2ToUpperCase: { support: 'browser', note: '' },
  v2SetCharAt: { support: 'browser', note: '' },
  v2SplitString: { support: 'browser', note: '' },
  v2ConcatString: { support: 'browser', note: '' },

  // v2 arrays and dicts
  v2MakeArrayVar: { support: 'browser', note: '' },
  v2GetArrayVarLength: { support: 'browser', note: '' },
  v2GetArrayVar: { support: 'browser', note: '' },
  v2SetArrayVar: { support: 'browser', note: '' },
  v2PushArrayVar: { support: 'browser', note: '' },
  v2PopArrayVar: { support: 'browser', note: '' },
  v2ShiftArrayVar: { support: 'browser', note: '' },
  v2UnshiftArrayVar: { support: 'browser', note: '' },
  v2SpliceArrayVar: { support: 'browser', note: '' },
  v2SliceArrayVar: { support: 'browser', note: '' },
  v2GetIndexOfValueInArrayVar: { support: 'browser', note: '' },
  v2RemoveIndexFromArrayVar: { support: 'browser', note: '' },
  v2JoinArrayVar: { support: 'browser', note: '' },
  v2MakeDictVar: { support: 'browser', note: '' },
  v2GetDictVar: { support: 'browser', note: '' },
  v2SetDictVar: { support: 'browser', note: '' },
  v2DeleteDictKey: { support: 'browser', note: '' },
  v2HasDictKey: { support: 'browser', note: '' },
  v2ClearDict: { support: 'browser', note: '' },
  v2GetDictSize: { support: 'browser', note: '' },
  v2GetDictKeys: { support: 'browser', note: '' },
  v2GetDictValues: { support: 'browser', note: '' },

  // v2 character, persona, notes, lore
  v2GetCharacterDesc: { support: 'browser', note: 'the description as this chat’s overlay has it' },
  v2SetCharacterDesc: { support: 'server', note: 'chat overlay' },
  v2GetPersonaDesc: { support: 'browser', note: '' },
  v2SetPersonaDesc: { support: 'server', note: 'chat overlay; the persona row is untouched' },
  v2GetReplaceGlobalNote: { support: 'browser', note: 'the card’s post-history instructions' },
  v2SetReplaceGlobalNote: { support: 'server', note: 'chat overlay' },
  v2GetAuthorNote: { support: 'browser', note: 'the chat note' },
  v2SetAuthorNote: { support: 'server', note: 'the chat note' },
  v2GetAllLorebooks: { support: 'browser', note: '' },
  v2GetLorebookByName: { support: 'browser', note: '' },
  v2GetLorebookByIndex: { support: 'browser', note: '' },
  v2GetLorebookCount: { support: 'browser', note: '' },
  v2GetLorebookCountNew: { support: 'browser', note: '' },
  v2CreateLorebook: { support: 'server', note: 'chat overlay' },
  v2ModifyLorebookByIndex: { support: 'server', note: 'chat overlay' },
  v2DeleteLorebookByIndex: { support: 'server', note: 'chat overlay' },
  v2SetLorebookAlwaysActive: { support: 'server', note: 'chat overlay' },
  v2GetLorebook: { support: 'logged', note: 'writes null: tuple-era lookup, finds nothing in RisuAI either' },
  v2GetLorebookEntry: { support: 'logged', note: 'writes null: tuple-era lookup' },
  v2GetLorebookIndexViaName: { support: 'logged', note: 'writes -1: tuple-era lookup' },
  v2ModifyLorebook: { support: 'logged', note: 'tuple-era: changes nothing in RisuAI either' },
  v2SetLorebookActivation: { support: 'logged', note: 'tuple-era: changes nothing in RisuAI either' },
};

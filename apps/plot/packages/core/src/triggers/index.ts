/**
 * RisuAI's card scripts — triggers and the `editinput`/`editoutput` regex
 * scripts — as pure functions the reader's browser runs (`@shizue/core/triggers`).
 * Nothing here stores anything or talks to the network: a run takes the chat as
 * it stands and returns what the scripts changed, and the browser's runtime
 * (`apps/web/src/lib/scripts`) carries each change to where it belongs.
 *
 * Free of the tokenizer and the card parser, like `variables.ts`, so the web
 * bundle can take it whole.
 */

export * from './scripts.js';
export * from './interpreter.js';
export { parseChatML, type ScriptChatTurn } from './chatML.js';
export * from './editScripts.js';
export * from './overlay.js';
export * from './chatEdits.js';
export { evaluateScriptCbs, renderOutTemplate, type ScriptCbsEnv, type TemplateMatch } from './cbsHost.js';
export { risuCalculate } from './calc.js';
export { TRIGGER_CLASSIFICATION, type TriggerSupport } from './classification.js';

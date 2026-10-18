/**
 * A model call a card's script asks for — RisuAI's Lua `LLM`, `axLLM` and
 * `simpleLLM`, and its triggers' `runLLM` and `v2RunLLM` — answered on the
 * reader's own ChatGPT account, through the chat's own model or its auxiliary
 * one.
 *
 * Which of the two is RisuAI's choice, carried over: `LLM`, `simpleLLM` and
 * `runLLM` ask for the main model (`'main'`), `axLLM` in every one of its modes
 * asks for the auxiliary model (`'sub'`), and `v2RunLLM` asks for whichever its
 * effect names. RisuAI can give each auxiliary mode a model of its own; here
 * they share the chat's one auxiliary model, resolved as the background work
 * resolves it (`auxiliaryModelOf`).
 *
 * The script runs in the reader's browser, in the Lua sandbox; this is the one
 * thing of the server it can reach, and only through the page, which forwards
 * the call (`apps/web/src/lib/scripts/lua/sandbox.ts`). The route holds it to
 * what RisuAI holds it to and to what a chat's own turn is held to:
 *
 * - the plot's scripted member must grant low-level access, as RisuAI keeps
 *   these functions behind it — the browser checks the same, and this is the
 *   check that does not depend on the browser;
 * - the chat must be the caller's and writable, and the call takes the chat's
 *   generation slot, so a script's call and a generation never run at once on
 *   one chat;
 * - the prompt is size-checked here as it is in the sandbox.
 *
 * The calls spend the reader's own account, as a RisuAI script spends its user's
 * API key. Nothing is stored. The answer is the model's text; RisuAI's
 * `{success, result}` wrapping is the sandbox's.
 */
import { ChatGPTError, getAdapter, type ChatMessage, type ChatRequest } from '@shizue/llm';
import type { AppDeps } from './deps.js';
import { ApiError, badRequest } from './errors.js';
import { collect } from './memory.js';

/** Which of the chat's models a call asks for: its own, or its auxiliary one. */
export type ScriptLlmModel = 'main' | 'sub';

/** Turns in one call, and characters across them. The sandbox refuses past the same lines. */
export const MAX_SCRIPT_LLM_MESSAGES = 200;
export const MAX_SCRIPT_LLM_CHARS = 400_000;
/** Longest one call may take; under the generation claim's staleness window it is renewed through. */
const SCRIPT_LLM_TIMEOUT_MS = 120_000;
/** A budget for adapters that take one; ChatGPT reads the prompt for length, not this. */
const SCRIPT_LLM_MAX_TOKENS = 4_096;

const ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant']);

/** The prompt as the sandbox sends it — RisuAI's roles already mapped — or a 400. */
export function readScriptLlmMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('invalid_request', 'messages must be a non-empty array');
  }
  if (value.length > MAX_SCRIPT_LLM_MESSAGES) {
    throw badRequest('script_llm_too_large', `A script's prompt holds at most ${MAX_SCRIPT_LLM_MESSAGES} turns`);
  }
  let total = 0;
  return value.map((message): ChatMessage => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      throw badRequest('invalid_request', 'Each message must be an object');
    }
    const { role, content } = message as Record<string, unknown>;
    if (typeof role !== 'string' || !ROLES.has(role)) {
      throw badRequest('invalid_request', 'role must be system, user or assistant');
    }
    if (typeof content !== 'string') throw badRequest('invalid_request', 'content must be a string');
    total += content.length;
    if (total > MAX_SCRIPT_LLM_CHARS) {
      throw badRequest('script_llm_too_large', `A script's prompt holds at most ${MAX_SCRIPT_LLM_CHARS} characters`);
    }
    return { role: role as ChatMessage['role'], content };
  });
}

/** The model a call names; the main one when it names none, a 400 for anything else. */
export function readScriptLlmModel(value: unknown): ScriptLlmModel {
  if (value === undefined || value === 'main') return 'main';
  if (value === 'sub') return 'sub';
  throw badRequest('invalid_request', "model must be 'main' or 'sub'");
}

/**
 * Sends the prompt to `model` on the reader's account and answers with the
 * text. System turns at the head become the instructions and the rest keep
 * their places, as the adapter turns a system turn into a developer one. A
 * model that does not answer is a 502 `script_llm_failed`; an account problem
 * is the adapter's own error, as on a turn.
 */
export async function runScriptLlm(
  deps: AppDeps,
  input: { userId: string; model: string; messages: ChatMessage[]; signal?: AbortSignal },
): Promise<string> {
  const account = deps.chatgpt?.accounts.forUser(input.userId);
  const resolved = await (deps.getAdapter ?? getAdapter)(input.model, deps.env, account);
  // A prompt of system turns alone keeps them as turns: there must be something to answer.
  const lead = input.messages.findIndex((message) => message.role !== 'system');
  const head = lead > 0 ? input.messages.slice(0, lead) : [];
  const rest = lead > 0 ? input.messages.slice(lead) : input.messages;
  const timeout = AbortSignal.timeout(SCRIPT_LLM_TIMEOUT_MS);
  const request: ChatRequest = {
    model: resolved.providerModel,
    system: head.map((message) => message.content).join('\n\n'),
    messages: rest,
    maxTokens: SCRIPT_LLM_MAX_TOKENS,
    abortSignal: input.signal ? AbortSignal.any([timeout, input.signal]) : timeout,
  };
  try {
    return await collect(resolved.adapter, request);
  } catch (error) {
    if (error instanceof ApiError || error instanceof ChatGPTError) throw error;
    // The card's script is told the call failed; what failed is the log's.
    console.error('[script-llm] call failed', error);
    throw new ApiError(502, 'script_llm_failed', 'The model did not answer');
  }
}

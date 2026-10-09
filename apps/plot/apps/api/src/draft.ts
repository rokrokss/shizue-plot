/**
 * AI plot draft (see docs/ARCHITECTURE.md §7).
 *
 * A premise in, a whole first version of a work out: title, reader-facing line,
 * setting, a small cast and one or two openings. Nothing is stored — the draft
 * is answered to the plot editor, which creates the plot through the ordinary POST,
 * so the editor stays the only place a work is written.
 *
 * The call goes to the default chat model rather than to the memory channel:
 * this is the creator's own writing being drafted, and the cheap summarizer is
 * not the model to hand that to.
 */
import { MAX_INTRO_LENGTH } from '@shizue/core';
import { getAdapter, listEnabledModels, type ChatGPTAccount, type ChatRequest } from '@shizue/llm';
import type { AppDeps } from './deps.js';
import { ApiError } from './errors.js';
import { normalizeTags } from './hub.js';
import { collect } from './memory.js';

/** The premise a creator hands over; a paragraph, not a manuscript. */
export const MAX_PREMISE_LENGTH = 2000;
/** Cast size of a draft — the editor adds the rest. */
const MAX_DRAFT_CHARACTERS = 3;
/** Openings a draft offers; the plot itself allows ten. */
const MAX_DRAFT_INTROS = 2;
/**
 * One drafted opening's length. Well inside the plot's own 4000-character cap
 * on purpose: this is a first scene the creator is going to rewrite, and a
 * drafted prologue that fills the editor is harder to work with than a short one.
 */
const MAX_DRAFT_INTRO_LENGTH = 2000;
const MAX_DRAFT_TAGS = 5;
/** One name is a line of a title bar, not a paragraph. */
const MAX_DRAFT_NAME_LENGTH = 100;
/** The setting the model will later be told; long enough to be worth editing. */
const MAX_DRAFT_DESCRIPTION_LENGTH = 4000;
/** Deadline for one draft call, so a hung provider frees the creator's slot. */
const DRAFT_TIMEOUT_MS = 60_000;
const DRAFT_MAX_TOKENS = 4000;
/** Parse failures tolerated before the draft is given up on. */
const DRAFT_ATTEMPTS = 2;

const DRAFT_RULES = `당신은 롤플레이 작품의 초안 작가입니다. 창작자가 건넨 한 문단짜리 premise를 읽고 대화형 작품의 초안을 씁니다.

규칙:
- premise가 쓰인 언어로 모든 필드를 씁니다.
- name은 작품 제목, intro는 독자에게 건네는 한 줄 소개, description은 모델이 읽는 세계관 설정입니다.
- characters는 1~3명이며, description에는 정체와 배경을, personality에는 성격과 말투를 씁니다.
- intros는 1~2개의 도입부입니다. 등장인물의 대사는 \`이름: 대사\` 줄로 쓰고, 접두사 없는 줄은 상황묘사이며, 상황묘사는 \`*…*\` 없이 그대로 씁니다.
- 도입부는 독자가 곧바로 답할 수 있는 장면에서 끝냅니다. 독자의 말과 행동은 대신 쓰지 않습니다.
- tags는 5개 이하의 짧은 분류어입니다.
- 실존 인물이나 저작권 있는 작품의 설정을 그대로 옮기지 않습니다.

출력 형식: 아래 스키마를 따르는 JSON 객체 하나만 출력합니다. 코드 블록이나 다른 텍스트를 덧붙이지 않습니다.
{
  "name": string,
  "intro": string,
  "description": string,
  "characters": [{"name": string, "description": string, "personality": string}],
  "intros": [string],
  "tags": [string]
}`;

export interface DraftCharacter {
  name: string;
  description: string;
  personality: string;
}

/** A draft as the plot editor receives it — the fields a create takes, and no id. */
export interface PlotDraft {
  name: string;
  intro: string;
  description: string;
  characters: DraftCharacter[];
  intros: string[];
  tags: string[];
}

/**
 * Drafts use the first model available to the creator's ChatGPT account,
 * matching the initial selection on the start-chat panel.
 */
const draftModel = async (deps: AppDeps, account: ChatGPTAccount | undefined): Promise<string> => {
  const model = (await listEnabledModels(deps.env, account))[0];
  if (!model) throw new ApiError(503, 'draft_unavailable', 'No chat model is configured');
  return model.id;
};

/**
 * Calls the model and parses its answer. One retry, because the failure this
 * guards against is a model that wrapped or prefaced its JSON rather than a
 * model that cannot write it; past that the creator gets a 502 and their premise
 * back, and nothing has been written anywhere.
 */
export async function draftPlot(deps: AppDeps, userId: string, premise: string): Promise<PlotDraft> {
  const account = deps.chatgpt?.accounts.forUser(userId);
  const modelId = await draftModel(deps, account);
  const resolved = await (deps.getAdapter ?? getAdapter)(modelId, deps.env, account);
  const request: ChatRequest = {
    model: resolved.providerModel,
    system: DRAFT_RULES,
    messages: [{ role: 'user', content: `[premise]\n${premise}` }],
    maxTokens: DRAFT_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
  };

  for (let attempt = 0; attempt < DRAFT_ATTEMPTS; attempt += 1) {
    try {
      const draft = parseDraftJson(await collect(resolved.adapter, request));
      if (draft) return draft;
    } catch (error) {
      // A provider failure reads the same as an unusable answer from here: the
      // creator gets one draft or none.
      console.error('[draft] call failed', error);
    }
  }
  throw new ApiError(502, 'draft_failed', 'The model did not return a usable draft');
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * The model's answer as a draft, or null when there is not enough of one to
 * hand over. A work needs a name and something to open with; everything else is
 * trimmed to the caps the editor enforces rather than refused, exactly as the
 * card import trims what it lifts off a card.
 */
function parseDraftJson(raw: string): PlotDraft | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const draft = parsed as Record<string, unknown>;

  const name = text(draft['name'], MAX_DRAFT_NAME_LENGTH);
  const intros = (Array.isArray(draft['intros']) ? draft['intros'] : [])
    .map((intro) => text(intro, MAX_DRAFT_INTRO_LENGTH))
    .filter((intro) => intro.length > 0)
    .slice(0, MAX_DRAFT_INTROS);
  if (!name || intros.length === 0) return null;

  const characters = (Array.isArray(draft['characters']) ? draft['characters'] : [])
    .filter((member): member is Record<string, unknown> => member !== null && typeof member === 'object')
    .map((member) => ({
      name: text(member['name'], MAX_DRAFT_NAME_LENGTH),
      description: text(member['description'], MAX_DRAFT_DESCRIPTION_LENGTH),
      personality: text(member['personality'], MAX_DRAFT_DESCRIPTION_LENGTH),
    }))
    // A member without a name is not one the roster can hold.
    .filter((member) => member.name.length > 0)
    .slice(0, MAX_DRAFT_CHARACTERS);

  return {
    name,
    intro: text(draft['intro'], MAX_INTRO_LENGTH),
    description: text(draft['description'], MAX_DRAFT_DESCRIPTION_LENGTH),
    characters,
    intros,
    tags: normalizeTags(
      (Array.isArray(draft['tags']) ? draft['tags'] : [])
        .filter((tag): tag is string => typeof tag === 'string')
        .slice(0, MAX_DRAFT_TAGS),
    ),
  };
}

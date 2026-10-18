/**
 * AI plot draft (see docs/ARCHITECTURE.md §7).
 *
 * A premise in, a whole first version of a work out: title, reader-facing line,
 * setting, a small cast and one or two openings. Nothing is stored — the draft
 * is answered to the plot editor, which creates the plot through the ordinary POST,
 * so the editor stays the only place a work is written.
 *
 * The call goes to the model preset the creator picked, else to the default
 * binding's sub model — the side work's, as the owner's plan of 2026-10-18 puts
 * drafts — which an open sub leaves to the main (§7.1).
 */
import { MAX_INTRO_LENGTH } from '@shizue/core';
import type { ChatRequest } from '@shizue/llm';
import type { AppDeps } from './deps.js';
import { ApiError } from './errors.js';
import { normalizeTags } from './hub.js';
import { collect } from './memory.js';
import { bindablePreset, modelOf, resolveModel, resolvePreset, type ResolvedModel } from './models.js';

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

const DRAFT_RULES = `You are the draft writer of a roleplay story. Read the one-paragraph premise the creator hands you and write a draft of an interactive story.

Rules:
- Write every field in the language the premise is written in.
- name is the story's title, intro is a one-line introduction for readers, and description is the world setting the model reads.
- characters holds 1–3 characters; write their identity and background in description, and their personality and way of speaking in personality.
- intros holds 1–2 openings. Write a character's lines as \`Name: line\` lines; a line with no prefix describes the situation, written as it is, without \`*…*\`.
- End an opening on a scene the reader can answer right away. Do not write the reader's words or actions for them.
- tags holds at most 5 short category words.
- Do not copy the settings of real people or of copyrighted works as they are.

Output format: output only one JSON object that follows the schema below. Do not add a code block or any other text.
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
 * Drafts use the preset the creator picked, held to their presets exactly as a
 * chat's binding is; without a pick, the default binding's sub model.
 */
const draftModel = async (deps: AppDeps, userId: string, requested: string | undefined): Promise<ResolvedModel> => {
  if (requested !== undefined) return modelOf(deps, userId, await bindablePreset(deps, userId, requested));
  const owner = { userId, modelBinding: null };
  if (!(await resolvePreset(deps, owner, 'sub'))) throw new ApiError(503, 'draft_unavailable', 'No model preset is set');
  return resolveModel(deps, owner, 'sub');
};

/**
 * Calls the model and parses its answer. One retry, because the failure this
 * guards against is a model that wrapped or prefaced its JSON rather than a
 * model that cannot write it; past that the creator gets a 502 and their premise
 * back, and nothing has been written anywhere.
 */
export async function draftPlot(
  deps: AppDeps,
  userId: string,
  premise: string,
  model?: string,
): Promise<PlotDraft> {
  const resolved = await draftModel(deps, userId, model);
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

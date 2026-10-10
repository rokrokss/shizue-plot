/**
 * Relationship stats (see docs/ARCHITECTURE.md, Phase 4 / Chunk 9).
 *
 * Six axes, 0-100, describing how the plot's characters collectively feel about
 * the user. One set of numbers per chat rather than one per member: the chat is
 * the plot's, and a per-character split is a separate feature.
 * Every fifth assistant turn the memory channel model reads the recent turns plus
 * the current numbers and answers with new ones and a one-line summary; the block
 * is then injected into the system prompt so the roster plays at the right
 * temperature.
 *
 * "Every fifth turn" is read off the branch, not counted per generation: the
 * trigger compares the assistant messages on the current path against the depth
 * the last extraction was attempted at. A regenerate swaps a reply and a continue
 * extends one, so neither moves the count; a branch switch to a shorter path
 * rebases it; and a turn completing while an extraction is in flight still counts,
 * because the next completion re-derives everything from the path.
 *
 * Like the memory refresh this runs after the SSE `done` event and swallows its
 * own failures. Unlike it there is no user-edit path, so there is no revision
 * counter either: the extraction is the only writer and the last write wins.
 */
import { DEFAULT_USER_NAME } from '@shizue/core';
import { transcriptLine } from './transcript.js';
import {
  chats,
  messages,
  personas,
  plots,
  RELATIONSHIP_AXES,
  type Chat,
  type ChatRelationship,
  type Message,
  type RelationshipAxes,
  type RelationshipAxis,
} from '@shizue/db';
import type { ChatRequest } from '@shizue/llm';
import { asc, eq } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { loadMembers } from './hub.js';
import { collect, memoryChannel } from './memory.js';
import { buildPath } from './tree.js';
import { unlockByRelationship } from './unlocks.js';

/** Assistant messages the branch must gain before the next extraction attempt. */
const TURNS_PER_UPDATE = 5;
/** How much of the branch tail the model reads. */
const RECENT_TURNS = 10;
/** Deadline for one extraction call, so a hung provider frees its slot. */
const RELATIONSHIP_TIMEOUT_MS = 30_000;
const RELATIONSHIP_MAX_TOKENS = 400;

const HEADING = '[현재 관계 상태]';

const AXIS_LABELS: Record<RelationshipAxis, string> = {
  affection: '애정',
  obsession: '집착',
  trust: '신뢰',
  liking: '호감',
  disgust: '혐오',
  fear: '두려움',
};

/**
 * Where a relationship starts before anything has happened: the three warm axes
 * sit at the midpoint (a neutral acquaintance, free to move either way) and the
 * three that need a cause — obsession, disgust, fear — start at zero.
 */
const DEFAULT_RELATIONSHIP_AXES: RelationshipAxes = {
  affection: 50,
  obsession: 0,
  trust: 50,
  liking: 50,
  disgust: 0,
  fear: 0,
};

const EXTRACTION_RULES = `당신은 롤플레이 대화의 관계 분석가입니다. 최근 대화를 읽고 작품의 등장인물들이 상대에게 공통으로 느끼는 감정을 6개 축의 수치로 갱신합니다.

축(각 0~100 정수):
- affection(애정): 상대를 아끼고 곁에 두고 싶은 마음
- obsession(집착): 상대를 독점하거나 통제하려는 마음
- trust(신뢰): 상대의 말과 행동을 믿는 정도
- liking(호감): 함께 있는 것이 즐겁고 편안한 정도
- disgust(혐오): 상대에게 느끼는 거부감
- fear(두려움): 상대를 두려워하거나 경계하는 정도

규칙:
- 현재 수치에서 출발해, 최근 대화에서 실제로 일어난 일만큼만 조정합니다. 아무 일도 없었다면 그대로 둡니다.
- 사건 없는 잡담은 ±3 이내, 고백·배신·구원·폭력처럼 관계를 뒤집는 사건만 ±20까지 움직입니다.
- 축은 서로 독립입니다. 애정이 높으면서 두려움도 높을 수 있습니다.
- 등장인물마다 온도가 다르면 장면에서 상대와 실제로 얽힌 인물들을 중심으로 종합합니다.
- 등장인물이 감정을 숨기더라도 겉으로 한 말이 아니라 실제로 느끼는 바를 적습니다.
- note는 지금의 관계를 한 문장으로 요약합니다. 대화에서 쓰인 언어와 같은 언어로 씁니다.

출력 형식: 아래 스키마를 따르는 JSON 객체 하나만 출력합니다. 코드 블록이나 다른 텍스트를 덧붙이지 않습니다.
{
  "axes": {"affection": 0-100 정수, "obsession": 0-100 정수, "trust": 0-100 정수, "liking": 0-100 정수, "disgust": 0-100 정수, "fear": 0-100 정수},
  "note": string
}`;

/* -------------------------------------------------------------- injection */

const axisLine = (axes: RelationshipAxes): string =>
  RELATIONSHIP_AXES.map((axis) => `${AXIS_LABELS[axis]} ${axes[axis]}`).join(' / ');

/**
 * The system block for one generation, or '' when there is nothing to inject —
 * the feature is off for this chat, or no extraction has succeeded yet.
 */
export function buildRelationshipText(chat: Chat): string {
  const axes = chat.relationshipEnabled ? chat.relationship?.axes : null;
  if (!axes) return '';
  const note = chat.relationship?.note.trim();
  return [
    HEADING,
    `${axisLine(axes)} (각 0~100)`,
    ...(note ? [`관계 요약: ${note}`] : []),
    '이 수치는 지금 {{char}}의 등장인물들이 {{user}}에게 느끼는 마음의 온도입니다. 수치를 직접 말하지 말고 말투와 태도로 드러내세요.',
  ].join('\n');
}

/* ------------------------------------------------------------------ update */

/**
 * Fire-and-forget relationship update. Must only be called after the response is
 * done: it reloads everything itself and never propagates a failure.
 */
export function scheduleRelationshipUpdate(deps: AppDeps, chatId: string): void {
  // One extraction per chat at a time, in its own guard set — a memory refresh
  // and a relationship update are unrelated jobs and must not block each other.
  // The guard is a pure concurrency gate and carries no counting state: turns
  // that complete while an extraction runs are still on the branch, so the next
  // completion sees them.
  if (deps.extractingRelationship.has(chatId)) return;
  deps.extractingRelationship.add(chatId);

  const task = updateRelationship(deps, chatId)
    .catch((error: unknown) => {
      console.error('[relationship] update failed', error);
    })
    .finally(() => deps.extractingRelationship.delete(chatId));
  deps.onBackgroundTask?.(task, 'relationship');
}

async function updateRelationship(deps: AppDeps, chatId: string): Promise<void> {
  const [row] = await deps.db
    .select({ chat: chats, plotName: plots.name, personaName: personas.name })
    .from(chats)
    .innerJoin(plots, eq(chats.plotId, plots.id))
    .leftJoin(personas, eq(chats.personaId, personas.id))
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!row) return;
  const chat = row.chat;
  // Turned off: no call, and no counting either — the numbers would be stale by
  // the time it is turned back on anyway.
  if (!chat.relationshipEnabled) return;

  const current = chat.relationship;
  // The branch is reloaded here rather than handed over by the generation: the
  // plan is built before the new reply is stored, so only a fresh read counts it.
  // This runs off the response path, like the memory refresh next to it.
  const all = await deps.db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt));
  const path = buildPath(all, chat.headMessageId);
  const depth = path.filter((message) => message.role === 'assistant').length;
  const extractedAt = current?.lastExtractedAssistantDepth ?? 0;

  // A branch switch can land on a path shorter than the one the last extraction
  // read. The depth then points past its end and would block every later update,
  // so it is rebased onto this branch; the numbers themselves still apply.
  if (depth < extractedAt) {
    await writeRelationship(deps, chatId, rebased(current, depth));
    return;
  }
  if (depth - extractedAt < TURNS_PER_UPDATE) return;

  const extracted = await extract(deps, {
    userId: chat.userId,
    axes: current?.axes ?? DEFAULT_RELATIONSHIP_AXES,
    recent: path.slice(-RECENT_TURNS),
    plotName: row.plotName,
    members: (await loadMembers(deps.db, chat.plotId)).map((member) => member.name),
    userName: row.personaName ?? DEFAULT_USER_NAME,
  });
  // Either way the attempt is recorded at the depth it read, never back at zero:
  // a failed call retries one cycle later instead of on every following turn, and
  // turns that landed while it ran keep counting toward the next one.
  await writeRelationship(
    deps,
    chatId,
    extracted
      ? {
          axes: extracted.axes,
          note: extracted.note,
          updatedAt: new Date().toISOString(),
          lastExtractedAssistantDepth: depth,
        }
      : rebased(current, depth),
  );
  if (extracted) await revealByRelationship(deps, chat, extracted.axes);
}

/**
 * Assets waiting on one of these axes, opened now that the numbers moved.
 *
 * The turn's own evaluation ran before this job did (`unlockAssets`, after the
 * `done` event), so it read the axes as they stood *before* the extraction — the
 * turn that crosses a threshold would otherwise never open what waits on it. The
 * reveal lands on the chat's next state read; there is no stream left to say it on.
 *
 * Its failures stay its own: the numbers are already written, and an unlock that
 * did not land is asked again after the next extraction.
 */
async function revealByRelationship(deps: AppDeps, chat: Chat, axes: RelationshipAxes): Promise<void> {
  try {
    await unlockByRelationship(deps, chat, axes);
  } catch (error) {
    console.error('[relationship] asset unlock evaluation failed', error);
  }
}

/**
 * The stored values as they are, with the extraction depth moved to `depth`. A
 * finished chat import writes one too, so the backlog it brought in is not read
 * as five turns overdue.
 */
export const rebased =(current: ChatRelationship | null, depth: number): ChatRelationship => ({
  axes: current?.axes ?? null,
  note: current?.note ?? '',
  updatedAt: current?.updatedAt ?? new Date().toISOString(),
  lastExtractedAssistantDepth: depth,
});

async function writeRelationship(
  deps: AppDeps,
  chatId: string,
  relationship: ChatRelationship,
): Promise<void> {
  // No CAS: nothing else writes this column, and a chat deleted meanwhile simply
  // matches no row.
  await deps.db.update(chats).set({ relationship }).where(eq(chats.id, chatId));
}

interface ExtractInput {
  /** The chat's owner, whose ChatGPT account reads the relationship. */
  userId: string;
  axes: RelationshipAxes;
  recent: Message[];
  plotName: string;
  /** The roster, in the creator's order; empty for a plot nobody has cast yet. */
  members: string[];
  userName: string;
}

/** Calls the memory channel model. Returns null on any failure — never throws. */
async function extract(
  deps: AppDeps,
  input: ExtractInput,
): Promise<{ axes: RelationshipAxes; note: string } | null> {
  const resolved = await memoryChannel(deps, input.userId);
  if (!resolved) return null;

  // Image references are markup for the chat: nothing to read a relationship from.
  const transcript = input.recent
    .map((message) => transcriptLine(message, input.userName))
    .join('\n');
  const request: ChatRequest = {
    model: resolved.providerModel,
    system: EXTRACTION_RULES,
    messages: [
      {
        role: 'user',
        content: [
          `[작품] ${input.plotName}`,
          `[등장인물] ${input.members.join(', ') || '(없음)'}`,
          `[상대] ${input.userName}`,
          '',
          '[현재 수치]',
          RELATIONSHIP_AXES.map((axis) => `${axis}: ${input.axes[axis]}`).join('\n'),
          '',
          '[최근 대화]',
          transcript,
        ].join('\n'),
      },
    ],
    maxTokens: RELATIONSHIP_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(RELATIONSHIP_TIMEOUT_MS),
  };

  try {
    return parseRelationshipJson(await collect(resolved.adapter, request));
  } catch (error) {
    console.error('[relationship] extraction failed', error);
    return null;
  }
}

/** Values come from a model, so they are clamped to the documented range here. */
const clamp = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

function parseRelationshipJson(raw: string): { axes: RelationshipAxes; note: string } | null {
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

  const { axes, note } = parsed as { axes?: unknown; note?: unknown };
  if (axes === null || typeof axes !== 'object') return null;

  const values = axes as Record<string, unknown>;
  const result = {} as RelationshipAxes;
  for (const axis of RELATIONSHIP_AXES) {
    const value = values[axis];
    // A partial answer is not usable: a missing axis would silently keep a number
    // the model never looked at.
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    result[axis] = clamp(value);
  }
  return { axes: result, note: typeof note === 'string' ? note.trim() : '' };
}

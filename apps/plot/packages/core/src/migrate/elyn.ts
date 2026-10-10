/**
 * Elyn (elyn.ai): one character with a free prompt, several first messages, a
 * lorebook with advanced settings and JSX components (design §5.2; fields in
 * KR-PLATFORM-MIGRATION.md §2.5).
 *
 * The prompt is the work's setting. Elyn has no roster, but prompts often keep
 * one as `## 이름` blocks under `# 캐릭터` — `splitSections` lifts those into
 * members. Units are mixed on the source (characters for the prompt and first
 * messages, bytes for lore), which the limits below keep.
 */

import { MAX_INTRO_LENGTH } from '../card/intro.js';
import { componentSubsetViolations, MAX_COMPONENT_CODE_LENGTH } from '../component.js';
import { MAX_CHARACTERS_PER_PLOT, MAX_INTRO_TEXT_LENGTH, MAX_INTROS_PER_PLOT, type LoreEntry } from '../types.js';
import {
  capped,
  imageListEntry,
  labelOf,
  limited,
  line,
  loreEntry,
  mainSpeaker,
  plotTags,
  preserve,
  preserveLoreNames,
  prose,
  rowsOf,
  scene,
  splitKeywords,
  text,
  warn,
  type Conversion,
} from './convert.js';
import type { MigrationDraft, MigrationDraftMember, SiteInput, SiteSchema } from './types.js';

export const ELYN_SCHEMA: SiteSchema = {
  platform: 'elyn',
  sections: [
    {
      id: 'profile',
      label: '기본 정보',
      fields: [
        { id: 'name', label: '이름', kind: 'line', visibility: 'public' },
        { id: 'intro', label: '캐릭터 소개말', kind: 'text', visibility: 'public', sourceLimit: { chars: 9000 } },
        { id: 'tags', label: '태그', kind: 'keywords', visibility: 'public' },
        {
          id: 'rating',
          label: '이용 등급',
          kind: 'choice',
          visibility: 'meta',
          options: [
            { value: 'all', label: '전체' },
            { value: 'adult', label: '성인 전용' },
          ],
        },
      ],
    },
    {
      id: 'prompt',
      label: '프롬프트',
      // 6,000 on the fixed plan and unlimited on the metered one, so no advisory.
      fields: [{ id: 'prompt', label: '프롬프트', kind: 'text', visibility: 'ai' }],
    },
    {
      id: 'firstMessages',
      label: '첫 메시지',
      repeat: { min: 1, max: 10 },
      fields: [
        {
          id: 'text',
          label: '첫 메시지',
          kind: 'turns',
          visibility: 'both',
          sourceLimit: { chars: 2000 },
        },
      ],
    },
    {
      id: 'lore',
      label: '로어',
      repeat: { min: 0, max: 250 },
      fields: [
        { id: 'name', label: '이름', kind: 'line', visibility: 'meta', sourceLimit: { bytes: 450 } },
        { id: 'content', label: '내용', kind: 'text', visibility: 'ai', sourceLimit: { bytes: 4500 } },
        { id: 'keys', label: '활성화 키', kind: 'keywords', visibility: 'ai' },
        {
          id: 'scanRange',
          label: '검색 범위',
          aliases: ['고급 설정 › 검색 범위'],
          kind: 'choice',
          visibility: 'meta',
          options: [
            { value: '0', label: '0' },
            { value: '1', label: '1' },
            { value: '2', label: '2' },
            { value: '3', label: '3' },
            { value: '4', label: '4' },
            { value: '5', label: '5' },
            { value: '6', label: '6' },
            { value: 'all', label: '전체' },
          ],
        },
        {
          id: 'onMatch',
          label: '찾았을 때',
          aliases: ['고급 설정 › 찾았을 때'],
          kind: 'choice',
          visibility: 'meta',
          options: [
            { value: 'activate', label: '활성화' },
            { value: 'deactivate', label: '비활성화' },
          ],
        },
        { id: 'group', label: '그룹', aliases: ['고급 설정 › 그룹'], kind: 'line', visibility: 'meta' },
        {
          id: 'priority',
          label: '우선순위',
          aliases: ['고급 설정 › 우선순위'],
          kind: 'line',
          visibility: 'meta',
        },
        {
          id: 'dependencies',
          label: '의존성',
          aliases: ['고급 설정 › 의존성'],
          kind: 'keywords',
          visibility: 'meta',
        },
      ],
    },
    {
      id: 'components',
      label: 'JSX 컴포넌트',
      repeat: { min: 0, max: 32 },
      fields: [{ id: 'code', label: '코드', kind: 'text', visibility: 'meta' }],
    },
  ],
  confirmations: [{ id: 'ownWork' }, { id: 'secondaryWork' }, { id: 'elynOnly' }],
};

/** Elyn counts its search range in turns, a user and a reply each; we count messages. */
function scanDepthOf(value: unknown): number | undefined {
  if (value === 'all') return 1000;
  if (value === '0') return 1;
  const turns = typeof value === 'string' && /^[1-6]$/.test(value) ? Number(value) : undefined;
  return turns === undefined ? undefined : turns * 2;
}

/** A level-1 heading that opens the roster. */
const CAST_HEADING = /^(?:캐릭터|등장인물)$/;

/** `#` / `##` headings, with emphasis around the title ignored. */
const heading = (row: string, level: 1 | 2): string | undefined => {
  const match = (level === 1 ? /^#(?!#)\s*(.+?)\s*$/ : /^##(?!#)\s*(.+?)\s*$/).exec(row);
  return match ? match[1]!.replace(/[*_`]/g, '').trim() || undefined : undefined;
};

/**
 * Lifts the `## 이름` blocks under a `# 캐릭터` / `# 등장인물` heading out of the
 * prompt into members; everything else stays the setting. A heading left with
 * nothing under it goes too. Fenced code is never read as headings.
 */
export function splitCastSections(prompt: string): { rest: string; members: MigrationDraftMember[] } {
  const rest: string[] = [];
  const members: { name: string; rows: string[] }[] = [];
  let fenced = false;
  let cast: { at: number; preface: boolean; found: boolean } | undefined;
  let member: { name: string; rows: string[] } | undefined;

  const closeCast = (): void => {
    // The heading only stays when it still heads something.
    if (cast && cast.found && !cast.preface) rest.splice(cast.at, 1);
    cast = undefined;
    member = undefined;
  };

  for (const row of prompt.split('\n')) {
    if (/^\s*(```|~~~)/.test(row)) fenced = !fenced;
    const h1 = fenced ? undefined : heading(row, 1);
    const h2 = fenced || !cast ? undefined : heading(row, 2);
    if (h1 !== undefined) {
      closeCast();
      if (CAST_HEADING.test(h1)) cast = { at: rest.length, preface: false, found: false };
      rest.push(row);
    } else if (h2 !== undefined) {
      member = { name: h2, rows: [] };
      members.push(member);
      cast!.found = true;
    } else if (member) {
      member.rows.push(row);
    } else {
      if (cast && row.trim()) cast.preface = true;
      rest.push(row);
    }
  }
  closeCast();

  return {
    rest: rest.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    members: members.map((m) => ({ name: m.name, description: m.rows.join('\n').trim() })),
  };
}

/** An asset macro as Elyn writes it, in a prompt or lore entry. */
const IMAGE_MACRO = /\{\{\s*img\s*::/i;

export function elynToDraft(c: Conversion, input: SiteInput): MigrationDraft {
  const name = line(input['name']);
  if (!name) warn(c, 'nameMissing', 'profile.name');
  if (input['rating'] === 'adult') warn(c, 'adultOnly', 'profile.rating');

  // 소개말 → the plot's intro and the character's, both in our 500 (D15).
  const introSource = prose(c, 'profile.intro', input['intro']);
  const intro = limited(c, 'profile.intro', labelOf(c, 'profile', 'intro'), introSource, MAX_INTRO_LENGTH);

  let description = prose(c, 'prompt.prompt', input['prompt']);
  let members: MigrationDraftMember[] = name ? [{ name, ...(intro ? { intro } : {}), description: '' }] : [];
  if (c.options.splitSections) {
    const split = splitCastSections(description);
    if (split.members.length === 0) warn(c, 'splitNoSections', 'prompt.prompt');
    else {
      description = split.rest;
      members = capped(c, 'prompt', split.members, MAX_CHARACTERS_PER_PLOT, (m) =>
        `## ${m.name}\n${m.description}`,
      );
    }
  }
  const roster = members.map((m) => m.name);
  // The character the first messages speak for: the one Elyn named, wherever it landed.
  const named = Math.max(roster.indexOf(name), 0);

  const intros = capped(
    c,
    'firstMessages',
    rowsOf(input, 'firstMessages').flatMap((row, i) => {
      const field = `firstMessages[${i}].text`;
      const opening = scene(c, field, row['text'], roster, mainSpeaker(c, field, roster, named), false);
      return opening ? [limited(c, field, labelOf(c, 'firstMessages', 'text'), opening, MAX_INTRO_TEXT_LENGTH)] : [];
    }),
    MAX_INTROS_PER_PLOT,
    (opening) => opening,
  );

  const lorebook: LoreEntry[] = [];
  const loreNames: { name: string; keys: string[]; order: number }[] = [];
  rowsOf(input, 'lore').forEach((row, i) => {
    const content = prose(c, `lore[${i}].content`, row['content']);
    if (!content) return;
    const keys = splitKeywords(row['keys']);
    if (keys.length === 0) warn(c, 'loreNoKeys', `lore[${i}].keys`);
    const scanDepth = scanDepthOf(row['scanRange']);
    // Ours has no inverse trigger; switched on, the entry would do the opposite.
    const inverted = row['onMatch'] === 'deactivate';
    if (inverted) warn(c, 'loreInverted', `lore[${i}].onMatch`);
    const group = line(row['group']);
    const priority = Number.parseInt(text(row['priority']), 10);
    // Elyn takes the group's highest priority; we draw by weight.
    if (group) warn(c, 'loreGroupApprox', `lore[${i}].group`);
    if (splitKeywords(row['dependencies']).length > 0) {
      warn(c, 'loreDependencyDropped', `lore[${i}].dependencies`);
    }
    loreNames.push({ name: line(row['name']), keys, order: lorebook.length });
    lorebook.push(
      loreEntry(keys, content, lorebook.length, {
        ...(inverted ? { enabled: false } : {}),
        ...(scanDepth !== undefined ? { scanDepth } : {}),
        ...(group ? { group } : {}),
        ...(group && Number.isFinite(priority)
          ? { groupWeight: Math.min(255, Math.max(0, priority)) + 1 }
          : {}),
      }),
    );
  });
  preserveLoreNames(c, labelOf(c, 'lore', 'name'), loreNames);
  // Elyn's manual image mode is an instruction in the prompt or a lore entry to
  // output `{{img::키}}`. Prompt assembly strips every asset macro, so that
  // instruction reaches the model with the token gone; the image list, which
  // spells the syntax in words, is what carries it instead — on by default then.
  const imageInstructions =
    IMAGE_MACRO.test(text(input['prompt'])) ||
    rowsOf(input, 'lore').some((row) => IMAGE_MACRO.test(text(row['content'])));
  if (imageInstructions) warn(c, 'imageInstructionsStripped', 'prompt.prompt');
  if (c.options.imageListLore ?? imageInstructions) {
    const images = imageListEntry(c, lorebook.length);
    if (images) lorebook.push(images);
  }

  // Components travel as written — code, not prose — joined into one module (D17).
  const codes = rowsOf(input, 'components')
    .map((row, i) => ({ field: `components[${i}].code`, code: text(row['code']).trim() }))
    .filter(({ code }) => code);
  for (const { field, code } of codes) {
    for (const violation of componentSubsetViolations(code)) {
      if (violation !== 'too_long') warn(c, 'componentSubset', field, { violation });
    }
  }
  let componentCode = codes.map(({ code }) => code).join('\n\n');
  if (componentCode.length > MAX_COMPONENT_CODE_LENGTH) {
    warn(c, 'componentTooLong', 'components', {
      limit: MAX_COMPONENT_CODE_LENGTH,
      length: componentCode.length,
    });
    for (const { code } of codes) preserve(c, labelOf(c, 'components', 'code'), code);
    componentCode = '';
  }

  return {
    platform: 'elyn',
    plot: {
      name,
      intro,
      description,
      tags: plotTags(c, 'profile.tags', input['tags']),
      intros,
      lorebook,
      ...(componentCode ? { customUi: { componentCode } } : {}),
    },
    members,
  };
}

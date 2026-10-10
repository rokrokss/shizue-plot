/**
 * Paste migration (`@shizue/core/migrate`): a creator moves their own character
 * from another Korean platform by copying each field off that platform's edit
 * screen into a form laid out the same way. Design: docs/KR-PASTE-MIGRATION-DESIGN.md.
 *
 * Every site is data — a schema of its fields and a mapper onto one
 * `MigrationDraft` — so the web draws every site with one form, and a field name
 * or limit found to be wrong on the real screen is a one-line schema fix.
 */

import type { LoreEntry, NarratorConfig, PlotCustomUi, PlotStyle } from '../types.js';

export type MigrationPlatform = 'zeta' | 'elyn' | 'caveduck' | 'babechat' | 'crack';

/* ------------------------------------------------------------------ schema */

export type SiteFieldKind =
  | 'line' // one line of text
  | 'text' // free text, newlines kept
  | 'turns' // scene text a speaker mode applies to
  | 'keywords' // split on `,` `|` and newlines
  | 'choice'
  | 'multiChoice';

/** Who sees a field on the source platform. Informational: drawn as a badge. */
export type SiteFieldVisibility = 'public' | 'ai' | 'both' | 'meta';

export interface SiteField {
  id: string;
  /** The field's name on the source screen, in Korean as it appears there. */
  label: string;
  /** Older or documented names of the same field, shown alongside. */
  aliases?: string[];
  kind: SiteFieldKind;
  visibility: SiteFieldVisibility;
  /** The source's own limit — advisory only; only our limits are enforced. */
  sourceLimit?: { chars?: number; bytes?: number; unverified?: boolean };
  /** For `choice` / `multiChoice`. */
  options?: { value: string; label: string }[];
  /** For `multiChoice`. */
  maxChoices?: number;
}

export interface SiteSection {
  id: string;
  /** The tab or block name on the source screen. */
  label: string;
  fields: SiteField[];
  /** A section the source repeats (characters, first messages, lore entries…). */
  repeat?: { min: number; max: number };
}

/** One question the creator must answer yes to before the form opens. */
export interface ConfirmationItem {
  id: string;
  /** Answering yes is impossible: the platform owns the work (Crack Original). */
  blocking?: boolean;
}

export interface SiteSchema {
  platform: MigrationPlatform;
  sections: SiteSection[];
  confirmations: ConfirmationItem[];
}

/**
 * What the creator typed into the form: field id → value, and for a repeated
 * section, section id → array of such records. Values are strings, or string
 * arrays for `multiChoice`.
 */
export type SiteInput = Record<string, unknown>;

/* --------------------------------------------------------------- conversion */

/**
 * How scene text becomes our speech protocol (`speech.ts`):
 * - `auto`: lines with quoted dialogue become the main speaker's (`이름: `), the
 *   rest stay the narrator's.
 * - `character`: every non-empty line becomes the main speaker's.
 * - `narrator`: left alone — every line is the narrator's.
 * - `verbatim`: left exactly as pasted.
 * Zeta's `@이름:` / `@:` is converted whatever the mode.
 */
export type SpeakerMode = 'auto' | 'character' | 'narrator' | 'verbatim';

/** An image the creator adds in the form; the file itself stays in the browser. */
export interface MigrationAsset {
  /** The source's reference for it (`{{img::name}}`), kept as the asset's `name`. */
  name: string;
  /** The source's description of when it shows, if any. */
  description?: string;
}

export interface ConvertOptions {
  /** Per scene field (`<sectionId>.<fieldId>`, or `<sectionId>[i].<fieldId>`), default `auto`. */
  speaker?: Record<string, SpeakerMode>;
  /** Member index whose name the scene field's lines go to, default 0. */
  mainSpeaker?: Record<string, number>;
  /** `{user}` / `{char}` → `{{user}}` / `{{char}}`. Default true. */
  normalizeBraces?: boolean;
  /** Generate the constant "image list" lore entry from described assets. Default per site. */
  imageListLore?: boolean;
  /** Elyn: split `## 이름` blocks under a `# 캐릭터` heading into members. Default false. */
  splitSections?: boolean;
  assets?: MigrationAsset[];
}

/* -------------------------------------------------------------------- draft */

export interface MigrationDraftMember {
  name: string;
  /** Reader-facing, ≤ 500 characters. */
  intro?: string;
  description: string;
  personality?: string;
  /** `<START>` blocks. */
  mesExample?: string;
}

/**
 * Where every site converges, and what `POST /api/plots/migrate` takes. Already
 * within our limits and in our protocol; the server re-validates it with the
 * coercers every other write uses.
 */
export interface MigrationDraft {
  platform: MigrationPlatform;
  plot: {
    name: string;
    intro: string;
    description: string;
    tags: string[];
    intros: string[];
    lorebook: LoreEntry[];
    narrator?: NarratorConfig;
    style?: PlotStyle;
    profiles?: { name: string; description: string }[];
    customUi?: PlotCustomUi;
  };
  /** 1–10. */
  members: MigrationDraftMember[];
}

/** Something the preview must tell the creator. `code` is an i18n key suffix. */
export interface MigrationWarning {
  code: string;
  /** The form field it concerns (`<sectionId>.<fieldId>` or `<sectionId>[i].<fieldId>`). */
  field?: string;
  detail?: Record<string, string | number>;
}

/** Source text with no counterpart here, offered as a download — never stored. */
export interface PreservedText {
  /** The source field's label (Korean, from the schema). */
  label: string;
  text: string;
}

export interface MigrationResult {
  draft: MigrationDraft;
  warnings: MigrationWarning[];
  preserved: PreservedText[];
}

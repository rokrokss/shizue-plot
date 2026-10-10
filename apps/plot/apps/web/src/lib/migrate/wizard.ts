/**
 * The paste-migration wizard's state, as pure functions: the form's values laid
 * out the way the site schema lays out its sections, the confirmations, the
 * preview's conversion options, the images, and the copy of all of it this
 * browser keeps per site so a long paste survives a reload.
 *
 * Nothing here knows a site. The schema (`@shizue/core/migrate`) says which
 * sections repeat and which fields they hold, and every accessor reads the value
 * by that schema — a field found to be named or ordered differently on the real
 * source screen is a fix to the schema, never to this file.
 */
import type {
  ConfirmationItem,
  ConvertOptions,
  MigrationAsset,
  MigrationWarning,
  MigrationPlatform,
  PreservedText,
  SiteField,
  SiteInput,
  SiteSchema,
  SiteSection,
  SpeakerMode,
} from '@shizue/core/migrate';
import { normalizeSlug } from '../assets';

/** Every site the picker names, in the order it names them; the core says which are open. */
export const MIGRATION_PLATFORMS: readonly MigrationPlatform[] = [
  'zeta',
  'elyn',
  'caveduck',
  'babechat',
  'crack',
];

export type WizardStep = 'confirm' | 'form' | 'images' | 'preview' | 'run';

export const WIZARD_STEPS: readonly WizardStep[] = ['confirm', 'form', 'images', 'preview', 'run'];

// ── the form's values ───────────────────────────────────────────────────────

/**
 * One record: field id → a string, or strings for `multiChoice`. A repeated
 * section's rows are records under its id; every other section's fields sit at
 * the top level of the input itself (field ids are unique across a site's flat
 * sections), so for those the input is the record.
 */
export type SiteRow = Record<string, unknown>;

/** `<sectionId>.<fieldId>`, or `<sectionId>[i].<fieldId>` in a repeated section. */
export const fieldPath = (sectionId: string, fieldId: string, index?: number): string =>
  index === undefined ? `${sectionId}.${fieldId}` : `${sectionId}[${index}].${fieldId}`;

const isRow = (value: unknown): value is SiteRow =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A fresh record for a section: every field blank. */
export function emptyRow(section: SiteSection): SiteRow {
  return Object.fromEntries(
    section.fields.map((field) => [field.id, field.kind === 'multiChoice' ? [] : '']),
  );
}

/** The section's records: a repeated section's rows, or the input itself for any other. */
export function sectionRows(input: SiteInput, section: SiteSection): SiteRow[] {
  if (!section.repeat) return [input];
  const value = input[section.id];
  return Array.isArray(value) ? value.filter(isRow) : [];
}

/** What one field holds, as the form shows it. */
export function fieldValue(row: SiteRow, field: SiteField): string | string[] {
  const value = row[field.id];
  if (field.kind === 'multiChoice') {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }
  return typeof value === 'string' ? value : '';
}

/** The input with one field of one record replaced. */
export function withField(
  input: SiteInput,
  section: SiteSection,
  fieldId: string,
  value: string | string[],
  index = 0,
): SiteInput {
  if (!section.repeat) return { ...input, [fieldId]: value };
  const rows = sectionRows(input, section);
  return {
    ...input,
    [section.id]: rows.map((row, at) => (at === index ? { ...row, [fieldId]: value } : row)),
  };
}

/** A blank row after `after` (or at the end), up to the section's maximum. */
export function withRowAdded(input: SiteInput, section: SiteSection, after?: number): SiteInput {
  const rows = sectionRows(input, section);
  if (!section.repeat || rows.length >= section.repeat.max) return input;
  const at = after === undefined ? rows.length : after + 1;
  return { ...input, [section.id]: [...rows.slice(0, at), emptyRow(section), ...rows.slice(at)] };
}

/** The input without row `index`, down to the section's minimum. */
export function withRowRemoved(input: SiteInput, section: SiteSection, index: number): SiteInput {
  const rows = sectionRows(input, section);
  if (!section.repeat || rows.length <= section.repeat.min) return input;
  return { ...input, [section.id]: rows.filter((_, at) => at !== index) };
}

/** The input with row `index` swapped with its neighbour `index + delta`. */
export function withRowMoved(
  input: SiteInput,
  section: SiteSection,
  index: number,
  delta: -1 | 1,
): SiteInput {
  const rows = [...sectionRows(input, section)];
  const target = index + delta;
  if (!section.repeat || target < 0 || target >= rows.length) return input;
  [rows[index], rows[target]] = [rows[target]!, rows[index]!];
  return { ...input, [section.id]: rows };
}

/**
 * The source's own name for a form path — `캐릭터 2 › 설명`, or a section alone
 * for a section path — so a warning in the preview says which field it is about.
 * Null for a path the schema does not have.
 */
export function fieldLabel(schema: SiteSchema, path: string): string | null {
  const match = /^([^.[]+)(?:\[(\d+)\])?(?:\.(.+))?$/.exec(path);
  const section = match ? schema.sections.find((each) => each.id === match[1]) : undefined;
  if (!match || !section) return null;
  const head = match[2] === undefined ? section.label : `${section.label} ${Number(match[2]) + 1}`;
  if (match[3] === undefined) return head;
  const field = section.fields.find((each) => each.id === match[3]);
  if (!field) return null;
  return field.label === section.label ? head : `${head} › ${field.label}`;
}

/** Whether anything at all was typed into the form. */
export function hasInput(input: SiteInput, schema: SiteSchema): boolean {
  return schema.sections.some((section) =>
    sectionRows(input, section).some((row) =>
      section.fields.some((field) => {
        const value = fieldValue(row, field);
        return typeof value === 'string' ? value.trim().length > 0 : value.length > 0;
      }),
    ),
  );
}

// ── confirmations ───────────────────────────────────────────────────────────

/**
 * Asked on every site before its own exclusivity questions (design §7): the
 * work is the creator's own, and a derivative work's rights are theirs to check
 * before it is published.
 */
export const COMMON_CONFIRMATIONS: readonly ConfirmationItem[] = [
  { id: 'ownWork' },
  { id: 'secondaryWork' },
];

/** The common questions, then the site's, each once. */
export function confirmationItems(schema: SiteSchema): ConfirmationItem[] {
  const seen = new Set<string>();
  return [...COMMON_CONFIRMATIONS, ...schema.confirmations].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** A site with a blocking item cannot be moved over at all. */
export const isBlocked = (items: readonly ConfirmationItem[]): boolean =>
  items.some((item) => item.blocking);

/** Every question answered yes, and none of them one that cannot be. */
export const confirmationsReady = (
  items: readonly ConfirmationItem[],
  checked: Readonly<Record<string, boolean>>,
): boolean => !isBlocked(items) && items.every((item) => checked[item.id] === true);

// ── the preview's options ───────────────────────────────────────────────────

export interface PreviewOptions {
  /** Per scene field path; a path left out is `auto`. */
  speaker: Record<string, SpeakerMode>;
  /** Per scene field path, the member index its lines go to; left out is the first. */
  mainSpeaker: Record<string, number>;
  normalizeBraces: boolean;
  /** Left out until the creator flips it: the site's default is the core's to decide. */
  imageListLore?: boolean;
  splitSections: boolean;
}

export const SPEAKER_MODES: readonly SpeakerMode[] = ['auto', 'character', 'narrator', 'verbatim'];

export const defaultOptions = (): PreviewOptions => ({
  speaker: {},
  mainSpeaker: {},
  normalizeBraces: true,
  splitSections: false,
});

/**
 * Whether the "image list" lore entry is made when the creator has not said
 * (design D7), as the core decides it: on where the source picks pictures by
 * their description, and on Elyn only when its text asks the model for
 * `{{img::…}}` — which the core says with `imageInstructionsStripped`.
 */
export const imageListDefault = (
  platform: MigrationPlatform,
  warnings: readonly MigrationWarning[],
): boolean =>
  platform === 'elyn' ? warnings.some((warning) => warning.code === 'imageInstructionsStripped') : true;

/** Every `turns` field of the input that has text, which is what a speaker mode applies to. */
export function sceneFields(
  schema: SiteSchema,
  input: SiteInput,
): { path: string; section: SiteSection; field: SiteField; index: number | undefined }[] {
  return schema.sections.flatMap((section) =>
    sectionRows(input, section).flatMap((row, at) =>
      section.fields
        .filter((field) => field.kind === 'turns' && String(fieldValue(row, field)).trim().length > 0)
        .map((field) => {
          const index = section.repeat ? at : undefined;
          return { path: fieldPath(section.id, field.id, index), section, field, index };
        }),
    ),
  );
}

/**
 * The options with every per-row key of one section renumbered: `order[i]` is the
 * old index of what is now row `i`, so a removed or moved row's speaker mode
 * follows the text it was chosen for.
 */
export function renumberOptions(
  options: PreviewOptions,
  sectionId: string,
  order: readonly number[],
): PreviewOptions {
  const prefix = `${sectionId}[`;
  const remap = <T>(byPath: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [path, value] of Object.entries(byPath)) {
      if (!path.startsWith(prefix)) {
        out[path] = value;
        continue;
      }
      const match = /^\[(\d+)\](.*)$/.exec(path.slice(sectionId.length));
      if (!match) continue;
      const now = order.indexOf(Number(match[1]));
      if (now >= 0) out[`${sectionId}[${now}]${match[2]}`] = value;
    }
    return out;
  };
  return { ...options, speaker: remap(options.speaker), mainSpeaker: remap(options.mainSpeaker) };
}

/** The new order of a section's rows after removing `index` from `count`. */
export const orderAfterRemove = (count: number, index: number): number[] =>
  Array.from({ length: count }, (_, at) => at).filter((at) => at !== index);

/** The new order after adding a blank row after `after`; the blank one is -1. */
export const orderAfterAdd = (count: number, after: number | undefined): number[] => {
  const order = Array.from({ length: count }, (_, at) => at);
  order.splice(after === undefined ? count : after + 1, 0, -1);
  return order;
};

/** The new order after swapping `index` with `index + delta`. */
export const orderAfterMove = (count: number, index: number, delta: -1 | 1): number[] => {
  const order = Array.from({ length: count }, (_, at) => at);
  const target = index + delta;
  if (target < 0 || target >= count) return order;
  [order[index], order[target]] = [order[target]!, order[index]!];
  return order;
};

// ── images ──────────────────────────────────────────────────────────────────

/** An image the creator added. The file stays in this page's memory only. */
export interface WizardImage {
  /** Local key for the list; not sent anywhere. */
  id: string;
  file: File;
  /** The source's reference for it — `{{img::name}}` resolves by this. */
  name: string;
  description: string;
  /** The member (by index) whose avatar this is; null for a plot image. */
  avatarOf: number | null;
}

/** The reference a picked file is proposed under: its name without the extension. */
export const referenceFromFileName = (fileName: string): string =>
  fileName.replace(/\.[^.]+$/, '').trim();

/** The images with `image` made member `member`'s avatar — and no other image that. */
export function assignAvatar(
  images: readonly WizardImage[],
  id: string,
  member: number | null,
): WizardImage[] {
  return images.map((image) => {
    if (image.id === id) return { ...image, avatarOf: member };
    return member !== null && image.avatarOf === member ? { ...image, avatarOf: null } : image;
  });
}

/** The plot images (not avatars) the conversion is told about. */
export const migrationAssets = (images: readonly WizardImage[]): MigrationAsset[] =>
  images
    .filter((image) => image.avatarOf === null)
    .map((image) => ({
      name: image.name.trim(),
      ...(image.description.trim() ? { description: image.description.trim() } : {}),
    }));

const MAX_SLUG_LENGTH = 40;

/**
 * A storage slug per reference name: the name folded the way the API folds one,
 * `asset-N` where nothing of it survives (a Korean name folds to nothing), and a
 * `-2`, `-3`… suffix where two would collide — the API replaces a slug that is
 * uploaded twice. The name, not the slug, is what `{{img::…}}` resolves by.
 */
export function assetSlugs(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name, index) => {
    const base = normalizeSlug(name) || `asset-${index + 1}`;
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) {
      const suffix = `-${n}`;
      slug = `${base.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
    }
    taken.add(slug);
    return slug;
  });
}

/** What the conversion is asked to do with the preview's choices. */
export function convertOptions(
  options: PreviewOptions,
  images: readonly WizardImage[],
  platform: MigrationPlatform,
): ConvertOptions {
  return {
    speaker: options.speaker,
    mainSpeaker: options.mainSpeaker,
    normalizeBraces: options.normalizeBraces,
    ...(options.imageListLore === undefined ? {} : { imageListLore: options.imageListLore }),
    ...(platform === 'elyn' ? { splitSections: options.splitSections } : {}),
    assets: migrationAssets(images),
  };
}

// ── the preserved text ──────────────────────────────────────────────────────

/**
 * The source text with no counterpart here, as one plain-text file: each piece
 * under its source label. Built in the browser and handed to the creator; it is
 * never part of a request.
 */
export function preservedFile(preserved: readonly PreservedText[]): string {
  return preserved.map((item) => `[${item.label}]\n${item.text.trim()}\n`).join('\n');
}

// ── what this browser keeps ─────────────────────────────────────────────────

/** The two methods the autosave uses, so a test can hand in a map. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const savedKey = (platform: MigrationPlatform): string => `shizue.migrate.${platform}`;

/** The wizard as saved: everything but the images, which are files. */
export interface SavedWizard {
  version: 1;
  step: Exclude<WizardStep, 'run'>;
  confirmations: Record<string, boolean>;
  sourceUrl: string;
  input: SiteInput;
  options: PreviewOptions;
  /** Images had been added; they are not kept, so the creator is asked to add them again. */
  hadImages: boolean;
}

/**
 * The browser's storage, or null where it cannot be had: a private window, blocked
 * site data, or a server render. Reading the property can itself throw.
 */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const SAVED_STEPS = new Set<string>(['confirm', 'form', 'images', 'preview']);

/** The saved wizard for a site, or null for none, an unreadable one, or no storage. */
export function readSaved(storage: StorageLike | null, platform: MigrationPlatform): SavedWizard | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(savedKey(platform));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRow(parsed) || parsed['version'] !== 1) return null;
    const { step, confirmations, sourceUrl, input, options, hadImages } = parsed;
    if (typeof step !== 'string' || !SAVED_STEPS.has(step)) return null;
    if (!isRow(confirmations) || !isRow(input) || !isRow(options)) return null;
    const defaults = defaultOptions();
    return {
      version: 1,
      step: step as SavedWizard['step'],
      confirmations: Object.fromEntries(
        Object.entries(confirmations).map(([id, value]) => [id, value === true]),
      ),
      sourceUrl: typeof sourceUrl === 'string' ? sourceUrl : '',
      input,
      options: {
        speaker: isRow(options['speaker']) ? (options['speaker'] as Record<string, SpeakerMode>) : {},
        mainSpeaker: isRow(options['mainSpeaker'])
          ? (options['mainSpeaker'] as Record<string, number>)
          : {},
        normalizeBraces:
          typeof options['normalizeBraces'] === 'boolean' ? options['normalizeBraces'] : defaults.normalizeBraces,
        ...(typeof options['imageListLore'] === 'boolean' ? { imageListLore: options['imageListLore'] } : {}),
        splitSections:
          typeof options['splitSections'] === 'boolean' ? options['splitSections'] : defaults.splitSections,
      },
      hadImages: hadImages === true,
    };
  } catch {
    return null;
  }
}

/** Saves the wizard; a full or refused storage leaves the form working as it was. */
export function writeSaved(
  storage: StorageLike | null,
  platform: MigrationPlatform,
  saved: SavedWizard,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(savedKey(platform), JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

export function clearSaved(storage: StorageLike | null, platform: MigrationPlatform): void {
  if (!storage) return;
  try {
    storage.removeItem(savedKey(platform));
  } catch {
    // Nothing to do: the copy stays, and the next save overwrites it.
  }
}

export function hasSaved(storage: StorageLike | null, platform: MigrationPlatform): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(savedKey(platform)) !== null;
  } catch {
    return false;
  }
}

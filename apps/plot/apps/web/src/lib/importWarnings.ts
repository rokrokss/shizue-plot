/**
 * What a card import left behind or cut, as the import routes answer it
 * (`importWarnings`, apps/api `ImportWarning`): a count per reason, every one a
 * cap or a file the card itself got wrong. The studio says so quietly.
 *
 * A plot import moves straight on to the new plot's studio, so the list is
 * handed over through this tab's session storage, read once there and gone.
 */

export const IMPORT_WARNING_CODES = [
  'assets_unsupported',
  'assets_missing',
  'assets_over_budget',
  'assets_over_limit',
  'greetings_over_limit',
  'greetings_cut',
  'stylesheet_over_limit',
  'background_over_limit',
] as const;

export type ImportWarningCode = (typeof IMPORT_WARNING_CODES)[number];

export interface ImportWarning {
  code: ImportWarningCode;
  count: number;
}

/** The answer's list, with anything this build has no words for left out. */
export function readImportWarnings(value: unknown): ImportWarning[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ImportWarning =>
      item !== null &&
      typeof item === 'object' &&
      (IMPORT_WARNING_CODES as readonly string[]).includes((item as ImportWarning).code) &&
      Number.isInteger((item as ImportWarning).count) &&
      (item as ImportWarning).count > 0,
  );
}

const storageKey = (plotId: string): string => `shizue:import-warnings:${plotId}`;

/** Keeps a plot import's warnings for the studio it moves on to. Storage that refuses loses them quietly. */
export function keepImportWarnings(plotId: string, value: unknown): void {
  const warnings = readImportWarnings(value);
  if (warnings.length === 0) return;
  try {
    sessionStorage.setItem(storageKey(plotId), JSON.stringify(warnings));
  } catch {
    // A private window or full storage: the plot is imported either way.
  }
}

/** The warnings an import kept for this plot, once: reading them clears them. */
export function takeImportWarnings(plotId: string): ImportWarning[] {
  try {
    const raw = sessionStorage.getItem(storageKey(plotId));
    if (raw === null) return [];
    sessionStorage.removeItem(storageKey(plotId));
    return readImportWarnings(JSON.parse(raw));
  } catch {
    return [];
  }
}

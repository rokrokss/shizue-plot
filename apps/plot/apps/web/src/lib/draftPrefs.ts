/**
 * What this browser remembers about the AI draft: the model preset the creator
 * last drafted with, and whether they keep the "how it works" guide open. Per browser,
 * like the embedding model and the folded 상태창 — a way of working, not a
 * setting of any plot, so neither goes to the server.
 */

const MODEL_KEY = 'shizue.draftModel';
const GUIDE_KEY = 'shizue.draftGuideOpen';

/**
 * The creator's last pick where the presets still have it, else '' — the
 * default binding's sub model, which the server drafts with when it is sent none.
 */
export function readDraftModel(offered: readonly { id: string }[]): string {
  if (typeof window === 'undefined') return '';
  try {
    const stored = window.localStorage.getItem(MODEL_KEY);
    return offered.some((preset) => preset.id === stored) ? stored! : '';
  } catch {
    return '';
  }
}

export function writeDraftModel(model: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MODEL_KEY, model);
  } catch {
    // Blocked site data: nothing is kept, and the next visit starts on the first model.
  }
}

/** Collapsed until this browser opened it. */
export function readDraftGuideOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(GUIDE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeDraftGuideOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(GUIDE_KEY, open ? '1' : '0');
  } catch {
    // A browser with storage refused still opens the guide for this visit.
  }
}

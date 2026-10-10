/**
 * Making the plot a paste migration describes: one `POST /api/plots/migrate`
 * that creates the private plot and its members together, then each member's
 * avatar, then each plot image under the source's own reference name.
 *
 * The steps after the first hang off the plot it made, so a failed upload is
 * retried against that plot — never by creating it again. Every request goes
 * through the injected `fetch`, and the image measuring through `measure`, so the
 * whole run is testable without a server or a canvas.
 *
 * What leaves the browser is the draft, the confirmations, the optional source
 * page and the image files. The preserved source text never does.
 */
import type { MigrationDraft, MigrationPlatform } from '@shizue/core/migrate';
import { ApiError, toApiError } from '../api';
import { measureImage, type AssetPreview } from '../assets';
import type { PlotDetail } from '../types';
import { assetSlugs, type WizardImage } from './wizard';

export interface MigrationDeps {
  fetch: typeof fetch;
  /** Size and thumbhash of an image, as the asset manager sends them; null when unreadable. */
  measure: (file: File) => Promise<AssetPreview | null>;
}

/** The page's own: the window's fetch (called unbound, as it must be) and the canvas measure. */
export const BROWSER_DEPS: MigrationDeps = {
  fetch: (input, init) => fetch(input, init),
  measure: measureImage,
};

/** What the run is asked to make. */
export interface MigrationPlan {
  platform: MigrationPlatform;
  /** The normalized source page, or null when none was given. */
  sourceUrl: string | null;
  draft: MigrationDraft;
  images: readonly WizardImage[];
}

export type MigrationStep =
  | { id: 'create'; kind: 'create' }
  | { id: string; kind: 'avatar'; member: number; image: WizardImage }
  | { id: string; kind: 'asset'; slug: string; image: WizardImage };

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface StepResult {
  status: StepStatus;
  error?: ApiError;
}

export interface RunState {
  /** The plot the create step made; null until it has. */
  plotId: string | null;
  /** Its members' ids, in the draft's order. */
  memberIds: string[];
  results: Record<string, StepResult>;
}

export const initialRun = (steps: readonly MigrationStep[]): RunState => ({
  plotId: null,
  memberIds: [],
  results: Object.fromEntries(steps.map((step) => [step.id, { status: 'pending' }])),
});

/**
 * The steps in the order they run: the plot, every avatar a member has (an image
 * for a member the draft does not have is dropped), then the plot images.
 */
export function planSteps(plan: MigrationPlan): MigrationStep[] {
  const avatars = plan.images.filter(
    (image) => image.avatarOf !== null && image.avatarOf < plan.draft.members.length,
  );
  const assets = plan.images.filter((image) => image.avatarOf === null);
  const slugs = assetSlugs(assets.map((image) => image.name));
  return [
    { id: 'create', kind: 'create' },
    ...avatars.map((image) => ({
      id: `avatar:${image.id}`,
      kind: 'avatar' as const,
      member: image.avatarOf!,
      image,
    })),
    ...assets.map((image, index) => ({
      id: `asset:${image.id}`,
      kind: 'asset' as const,
      slug: slugs[index]!,
      image,
    })),
  ];
}

const asApiError = (caught: unknown): ApiError =>
  caught instanceof ApiError
    ? caught
    : new ApiError(0, 'unknown', caught instanceof Error ? caught.message : String(caught));

async function send<T>(deps: Pick<MigrationDeps, 'fetch'>, path: string, init: RequestInit): Promise<T> {
  const res = await deps.fetch(path, init);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

function form(file: File, fields: Record<string, string> = {}): FormData {
  const body = new FormData();
  body.append('file', file);
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return body;
}

/** The body of the one create request. The API refuses it without both confirmations. */
export const createBody = (plan: MigrationPlan) => ({
  platform: plan.platform,
  ...(plan.sourceUrl ? { sourceUrl: plan.sourceUrl } : {}),
  confirmations: { ownWork: true, notExclusive: true },
  draft: plan.draft,
});

async function runStep(
  step: MigrationStep,
  plan: MigrationPlan,
  state: RunState,
  deps: MigrationDeps,
): Promise<RunState> {
  if (step.kind === 'create') {
    const created = await send<PlotDetail>(deps, '/api/plots/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody(plan)),
    });
    const members = [...created.characters].sort((a, b) => a.orderIndex - b.orderIndex);
    return { ...state, plotId: created.id, memberIds: members.map((member) => member.id) };
  }
  const plotId = state.plotId!;
  if (step.kind === 'avatar') {
    const memberId = state.memberIds[step.member];
    if (!memberId) throw new ApiError(0, 'not_found', 'No such member');
    await send(deps, `/api/plots/${plotId}/characters/${memberId}/avatar`, {
      method: 'POST',
      body: form(step.image.file),
    });
    return state;
  }
  // Measured here, as the asset manager does, so the chat has a placeholder to draw.
  const preview = await deps.measure(step.image.file);
  await send(deps, `/api/plots/${plotId}/assets`, {
    method: 'POST',
    body: form(step.image.file, {
      slug: step.slug,
      name: step.image.name.trim(),
      ...(preview
        ? { width: String(preview.width), height: String(preview.height), thumbhash: preview.thumbhash }
        : {}),
    }),
  });
  return state;
}

/**
 * Runs every step not yet done, in order, and reports each change. A failed
 * create stops the run — there is no plot to hang the rest on — and leaves the
 * rest pending; a failed upload is recorded and the run goes on. Called again
 * with the state it returned, it picks up exactly the steps that did not finish.
 */
export async function runMigration(
  plan: MigrationPlan,
  steps: readonly MigrationStep[],
  previous: RunState,
  deps: MigrationDeps,
  onUpdate: (state: RunState) => void = () => undefined,
): Promise<RunState> {
  let state: RunState = { ...previous, results: { ...previous.results } };
  const set = (id: string, result: StepResult): void => {
    state = { ...state, results: { ...state.results, [id]: result } };
    onUpdate(state);
  };

  for (const step of steps) {
    if (state.results[step.id]?.status === 'done') continue;
    if (step.kind !== 'create' && state.plotId === null) continue;
    set(step.id, { status: 'running' });
    try {
      state = await runStep(step, plan, state, deps);
      set(step.id, { status: 'done' });
    } catch (caught) {
      set(step.id, { status: 'failed', error: asApiError(caught) });
      if (step.kind === 'create') break;
    }
  }
  return state;
}

/** Whether every step finished. */
export const runComplete = (steps: readonly MigrationStep[], state: RunState): boolean =>
  steps.every((step) => state.results[step.id]?.status === 'done');

// ── already here? ───────────────────────────────────────────────────────────

/**
 * The hash a paste-imported member carries: lowercase hex SHA-256 of the draft's
 * canonical string (`draftFingerprint` in core, which the API hashes the same way).
 */
export async function fingerprintHash(canonical: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The plots an earlier migration of this very draft made, by id; empty when none.
 * The same `POST /api/imports/lookup` the SillyTavern move asks, with one hash.
 */
export async function importedPlots(
  fetcher: typeof fetch,
  canonical: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const sha256 = await fingerprintHash(canonical);
  const found = await send<{ characters: { sha256: string; plotId: string }[] }>(
    { fetch: fetcher },
    '/api/imports/lookup',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha256: [sha256] }),
      ...(signal ? { signal } : {}),
    },
  );
  return [
    ...new Set(found.characters.filter((row) => row.sha256 === sha256).map((row) => row.plotId)),
  ];
}

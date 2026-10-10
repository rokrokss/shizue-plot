/**
 * The paste migration without a server: the form's values laid out by a site
 * schema, the confirmations, the storage slugs a batch of images gets, the copy
 * this browser keeps (and what it does when the storage refuses), and the run
 * against an in-memory API behind the injected `fetch` — the order it asks in,
 * what a failed upload leaves, and that a retry never makes the plot twice.
 */
import type { MigrationDraft, SiteSchema, SiteSection } from '@shizue/core/migrate';
import { describe, expect, it, vi } from 'vitest';
import {
  fingerprintHash,
  importedPlots,
  initialRun,
  planSteps,
  runComplete,
  runMigration,
  type MigrationDeps,
  type MigrationPlan,
} from '../src/lib/migrate/run';
import {
  assetSlugs,
  assignAvatar,
  clearSaved,
  confirmationItems,
  confirmationsReady,
  convertOptions,
  defaultOptions,
  fieldLabel,
  fieldPath,
  fieldValue,
  hasSaved,
  imageListDefault,
  orderAfterMove,
  orderAfterRemove,
  preservedFile,
  readSaved,
  renumberOptions,
  sceneFields,
  sectionRows,
  withField,
  withRowAdded,
  withRowMoved,
  withRowRemoved,
  writeSaved,
  type SavedWizard,
  type StorageLike,
  type WizardImage,
} from '../src/lib/migrate/wizard';

// ── a site ──────────────────────────────────────────────────────────────────

const basics: SiteSection = {
  id: 'basics',
  label: '기본',
  fields: [
    { id: 'title', label: '제목', kind: 'line', visibility: 'public' },
    { id: 'moods', label: '분위기', kind: 'multiChoice', visibility: 'ai', maxChoices: 2 },
  ],
};
const intros: SiteSection = {
  id: 'intros',
  label: '인트로',
  repeat: { min: 1, max: 3 },
  fields: [{ id: 'text', label: '내용', kind: 'turns', visibility: 'both' }],
};
const schema: SiteSchema = {
  platform: 'zeta',
  sections: [basics, intros],
  confirmations: [{ id: 'notExclusive' }],
};

describe('the form’s values', () => {
  it('reads and writes a flat section at the top level and a repeated one under its id', () => {
    let input = {};
    input = withField(input, basics, 'title', '밤의 서점');
    expect(input).toEqual({ title: '밤의 서점' });
    expect(fieldValue(sectionRows(input, basics)[0]!, basics.fields[0]!)).toBe('밤의 서점');
    expect(fieldValue(sectionRows(input, basics)[0]!, basics.fields[1]!)).toEqual([]);

    input = withRowAdded(input, intros);
    input = withRowAdded(input, intros);
    input = withField(input, intros, 'text', '둘째', 1);
    expect(input).toEqual({ title: '밤의 서점', intros: [{ text: '' }, { text: '둘째' }] });
    expect(fieldPath('intros', 'text', 1)).toBe('intros[1].text');
    expect(fieldPath('basics', 'title')).toBe('basics.title');
  });

  it('keeps a repeated section between its minimum and maximum', () => {
    let input = withRowAdded({}, intros);
    expect(withRowRemoved(input, intros, 0)).toBe(input);
    input = withRowAdded(withRowAdded(input, intros), intros);
    expect(withRowAdded(input, intros)).toBe(input);
    expect(sectionRows(input, intros)).toHaveLength(3);
  });

  it('adds a row after the one it is asked to and swaps neighbours', () => {
    let input = { intros: [{ text: 'a' }, { text: 'b' }] };
    input = withRowAdded(input, intros, 0) as typeof input;
    expect(sectionRows(input, intros).map((row) => row['text'])).toEqual(['a', '', 'b']);
    const moved = withRowMoved(input, intros, 2, -1);
    expect(sectionRows(moved, intros).map((row) => row['text'])).toEqual(['a', 'b', '']);
    expect(withRowMoved(input, intros, 0, -1)).toBe(input);
  });

  it('names a path the way the source screen does', () => {
    expect(fieldLabel(schema, 'intros[1].text')).toBe('인트로 2 › 내용');
    expect(fieldLabel(schema, 'basics.title')).toBe('기본 › 제목');
    expect(fieldLabel(schema, 'intros')).toBe('인트로');
    expect(fieldLabel(schema, 'nowhere.title')).toBeNull();
    expect(fieldLabel(schema, 'basics.nothing')).toBeNull();
  });

  it('lists the scene fields that have text, by path', () => {
    const input = { title: 'x', intros: [{ text: '' }, { text: '@: 비가 온다.' }] };
    expect(sceneFields(schema, input).map((scene) => scene.path)).toEqual(['intros[1].text']);
  });

  it('moves a scene field’s speaker choices with its row', () => {
    const options = {
      ...defaultOptions(),
      speaker: { 'intros[0].text': 'narrator' as const, 'intros[1].text': 'character' as const, 'basics.x': 'verbatim' as const },
      mainSpeaker: { 'intros[1].text': 2 },
    };
    const removed = renumberOptions(options, 'intros', orderAfterRemove(2, 0));
    expect(removed.speaker).toEqual({ 'intros[0].text': 'character', 'basics.x': 'verbatim' });
    expect(removed.mainSpeaker).toEqual({ 'intros[0].text': 2 });
    const moved = renumberOptions(options, 'intros', orderAfterMove(2, 0, 1));
    expect(moved.speaker).toEqual({ 'intros[1].text': 'narrator', 'intros[0].text': 'character', 'basics.x': 'verbatim' });
  });
});

describe('the confirmations', () => {
  it('asks the common questions first, then the site’s, each once', () => {
    const items = confirmationItems({ ...schema, confirmations: [{ id: 'ownWork' }, { id: 'elynOnly' }] });
    expect(items.map((item) => item.id)).toEqual(['ownWork', 'secondaryWork', 'elynOnly']);
  });

  it('is ready only with every box checked, and never with a blocking item', () => {
    const items = confirmationItems(schema);
    expect(confirmationsReady(items, { ownWork: true, secondaryWork: true })).toBe(false);
    expect(confirmationsReady(items, { ownWork: true, secondaryWork: true, notExclusive: true })).toBe(true);
    const blocked = confirmationItems({ ...schema, confirmations: [{ id: 'crackOriginal', blocking: true }] });
    expect(
      confirmationsReady(blocked, { ownWork: true, secondaryWork: true, crackOriginal: true }),
    ).toBe(false);
  });
});

// ── images ──────────────────────────────────────────────────────────────────

const image = (id: string, name: string, avatarOf: number | null = null, description = ''): WizardImage => ({
  id,
  file: new File([new Uint8Array([1, 2, 3])], `${name}.png`, { type: 'image/png' }),
  name,
  description,
  avatarOf,
});

describe('the images', () => {
  it('gives every image a slug the API keeps apart', () => {
    expect(assetSlugs(['Smile', '웃음', 'smile', '울음', 'a'.repeat(45), 'a'.repeat(45)])).toEqual([
      'smile',
      'asset-2',
      'smile-2',
      'asset-4',
      'a'.repeat(40),
      `${'a'.repeat(38)}-2`,
    ]);
  });

  it('makes one image a member’s avatar and lets go of the one it replaces', () => {
    const images = [image('1', 'a', 0), image('2', 'b')];
    expect(assignAvatar(images, '2', 0).map((each) => each.avatarOf)).toEqual([null, 0]);
  });

  it('tells the conversion about the plot images only', () => {
    const options = convertOptions(defaultOptions(), [image('1', '얼굴', 0), image('2', '웃음', null, ' 웃는 얼굴 ')], 'zeta');
    expect(options.assets).toEqual([{ name: '웃음', description: '웃는 얼굴' }]);
    // Untouched, the image list is the core's call; flipped, it is the creator's.
    expect('imageListLore' in options).toBe(false);
    expect('splitSections' in options).toBe(false);
    expect(convertOptions({ ...defaultOptions(), imageListLore: false }, [], 'elyn')).toMatchObject({
      imageListLore: false,
      splitSections: false,
    });
  });

  it('shows the image list’s default the way the core decides it', () => {
    expect(imageListDefault('zeta', [])).toBe(true);
    expect(imageListDefault('elyn', [])).toBe(false);
    expect(imageListDefault('elyn', [{ code: 'imageInstructionsStripped', field: 'prompt.prompt' }])).toBe(true);
  });
});

describe('the preserved text', () => {
  it('is one file of labelled pieces', () => {
    expect(preservedFile([{ label: '플러그인', text: '퀘스트\n' }, { label: '엔딩', text: '해피' }])).toBe(
      '[플러그인]\n퀘스트\n\n[엔딩]\n해피\n',
    );
  });
});

// ── what this browser keeps ─────────────────────────────────────────────────

const saved: SavedWizard = {
  version: 1,
  step: 'form',
  confirmations: { ownWork: true },
  sourceUrl: '',
  input: { title: '밤' },
  options: defaultOptions(),
  hadImages: true,
};

function mapStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

describe('the autosave', () => {
  it('keeps the wizard per site and gives it back', () => {
    const storage = mapStorage();
    expect(writeSaved(storage, 'zeta', saved)).toBe(true);
    expect([...storage.map.keys()]).toEqual(['shizue.migrate.zeta']);
    expect(readSaved(storage, 'zeta')).toEqual(saved);
    expect(readSaved(storage, 'elyn')).toBeNull();
    expect(hasSaved(storage, 'zeta')).toBe(true);
    clearSaved(storage, 'zeta');
    expect(hasSaved(storage, 'zeta')).toBe(false);
  });

  it('works on without a storage, or with one that refuses or holds junk', () => {
    const refusing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(writeSaved(refusing, 'zeta', saved)).toBe(false);
    expect(readSaved(refusing, 'zeta')).toBeNull();
    expect(hasSaved(refusing, 'zeta')).toBe(false);
    expect(() => clearSaved(refusing, 'zeta')).not.toThrow();
    expect(readSaved(null, 'zeta')).toBeNull();
    expect(writeSaved(null, 'zeta', saved)).toBe(false);

    const junk = mapStorage();
    junk.map.set('shizue.migrate.zeta', '{not json');
    expect(readSaved(junk, 'zeta')).toBeNull();
    junk.map.set('shizue.migrate.zeta', JSON.stringify({ ...saved, step: 'run' }));
    expect(readSaved(junk, 'zeta')).toBeNull();
    junk.map.set('shizue.migrate.zeta', JSON.stringify({ ...saved, version: 2 }));
    expect(readSaved(junk, 'zeta')).toBeNull();
  });
});

// ── the run ─────────────────────────────────────────────────────────────────

const draft = {
  platform: 'zeta',
  plot: { name: '밤의 서점', intro: '', description: '서점', tags: [], intros: [], lorebook: [] },
  members: [
    { name: '앨리스', description: '사서' },
    { name: '밥', description: '손님' },
  ],
} as MigrationDraft;

const plan = (images: WizardImage[]): MigrationPlan => ({
  platform: 'zeta',
  sourceUrl: 'https://zeta-ai.io/ko/plots/1/profile',
  draft,
  images,
});

/** The routes the run calls, answered from plain state; `fail` queues error answers by route. */
function fakeApi() {
  const log: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fail = new Map<string, number>();
  let plots = 0;
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const route = `${init.method ?? 'GET'} ${String(input)}`;
    log.push(route);
    const left = fail.get(route) ?? 0;
    if (left > 0) {
      fail.set(route, left - 1);
      return json(500, { error: 'stubbed', code: 'internal_error' });
    }
    if (init.body instanceof FormData) {
      bodies.push(Object.fromEntries([...init.body.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : (value as File).name])));
    } else if (typeof init.body === 'string') {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    if (route === 'POST /api/plots/migrate') {
      plots += 1;
      // Members come back out of order: the run sorts by orderIndex.
      return json(201, {
        id: `plot-${plots}`,
        characters: [
          { id: 'member-bob', orderIndex: 1 },
          { id: 'member-alice', orderIndex: 0 },
        ],
      });
    }
    if (route === 'POST /api/imports/lookup') {
      return json(200, { characters: [{ sha256: 'other', plotId: 'x', characterId: 'y' }], chats: [] });
    }
    return json(201, {});
  });
  const deps: MigrationDeps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    measure: async () => ({ width: 4, height: 3, thumbhash: 'hash' }),
  };
  return { deps, log, bodies, fail, plots: () => plots };
}

describe('the run', () => {
  it('creates the plot, then the avatars, then the images under their source names', async () => {
    const api = fakeApi();
    const images = [image('i1', '웃음', null, '웃는 얼굴'), image('i2', 'bob-face', 1), image('i3', 'smile')];
    const migration = plan(images);
    const steps = planSteps(migration);
    expect(steps.map((step) => step.kind)).toEqual(['create', 'avatar', 'asset', 'asset']);

    const updates: string[] = [];
    const state = await runMigration(migration, steps, initialRun(steps), api.deps, (now) =>
      updates.push(Object.values(now.results).map((result) => result.status[0]).join('')),
    );

    expect(api.log).toEqual([
      'POST /api/plots/migrate',
      'POST /api/plots/plot-1/characters/member-bob/avatar',
      'POST /api/plots/plot-1/assets',
      'POST /api/plots/plot-1/assets',
    ]);
    expect(api.bodies[0]).toEqual({
      platform: 'zeta',
      sourceUrl: 'https://zeta-ai.io/ko/plots/1/profile',
      confirmations: { ownWork: true, notExclusive: true },
      draft,
    });
    expect(api.bodies[2]).toEqual({ file: '웃음.png', slug: 'asset-1', name: '웃음', width: '4', height: '3', thumbhash: 'hash' });
    expect(api.bodies[3]).toMatchObject({ slug: 'smile', name: 'smile' });
    expect(state.plotId).toBe('plot-1');
    expect(state.memberIds).toEqual(['member-alice', 'member-bob']);
    expect(runComplete(steps, state)).toBe(true);
    expect(updates[0]).toBe('rppp');
  });

  it('records a failed upload, goes on, and retries only it — on the same plot', async () => {
    const api = fakeApi();
    api.fail.set('POST /api/plots/plot-1/assets', 1);
    const migration = plan([image('i1', 'a'), image('i2', 'b')]);
    const steps = planSteps(migration);

    const first = await runMigration(migration, steps, initialRun(steps), api.deps);
    expect(first.results['asset:i1']).toMatchObject({ status: 'failed', error: { code: 'internal_error' } });
    expect(first.results['asset:i2']?.status).toBe('done');
    expect(runComplete(steps, first)).toBe(false);

    api.log.length = 0;
    const second = await runMigration(migration, steps, first, api.deps);
    expect(api.log).toEqual(['POST /api/plots/plot-1/assets']);
    expect(api.plots()).toBe(1);
    expect(runComplete(steps, second)).toBe(true);
  });

  it('stops at a failed create with the rest pending, and a retry creates it then', async () => {
    const api = fakeApi();
    api.fail.set('POST /api/plots/migrate', 1);
    const migration = plan([image('i1', 'a')]);
    const steps = planSteps(migration);

    const first = await runMigration(migration, steps, initialRun(steps), api.deps);
    expect(first.results['create']?.status).toBe('failed');
    expect(first.results['asset:i1']?.status).toBe('pending');
    expect(first.plotId).toBeNull();
    expect(api.log).toEqual(['POST /api/plots/migrate']);

    const second = await runMigration(migration, steps, first, api.deps);
    expect(second.plotId).toBe('plot-1');
    expect(runComplete(steps, second)).toBe(true);
  });

  it('drops an avatar for a member the draft does not have', () => {
    expect(planSteps(plan([image('i1', 'a', 5)])).map((step) => step.kind)).toEqual(['create']);
  });
});

describe('the already-imported check', () => {
  it('hashes the canonical draft and asks the lookup for it', async () => {
    // SHA-256 of "abc".
    const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(await fingerprintHash('abc')).toBe(abc);

    const api = fakeApi();
    expect(await importedPlots(api.deps.fetch, 'abc')).toEqual([]);
    expect(api.bodies[0]).toEqual({ sha256: [abc] });

    // Two members of one earlier plot carry the hash; the plot is named once.
    const hit = vi.fn(async () =>
      Response.json({
        characters: [
          { sha256: abc, plotId: 'p1', characterId: 'c1' },
          { sha256: abc, plotId: 'p1', characterId: 'c2' },
        ],
        chats: [],
      }),
    );
    expect(await importedPlots(hit as unknown as typeof fetch, 'abc')).toEqual(['p1']);
  });
});

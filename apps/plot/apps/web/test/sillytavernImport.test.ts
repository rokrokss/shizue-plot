/**
 * The SillyTavern move without a server: the review set against an earlier
 * run's lookup, the plan's order, the batches a chat is cut into, and the run
 * against an in-memory stand-in for the API behind the injected `fetch` — what
 * is asked for in which order, what a second run leaves alone, and what a
 * cancel, a failure and a retry each leave behind.
 */
import type { ImportedChatMessage } from '@shizue/core';
import type {
  StCharacter,
  StChatFile,
  StFile,
  StGroup,
  StManifest,
  StPersona,
} from '@shizue/core/sillytavern';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import { folderFiles, guardFiles } from '../src/lib/sillytavern/files';
import {
  BATCH_MESSAGES,
  batchMessages,
  capVersions,
  defaultSelection,
  DEFAULT_OPTIONS,
  fitRows,
  initialResults,
  planImport,
  reviewImport,
  runImport,
  type ImportDeps,
  type ImportLookup,
  type ImportOptions,
  type ImportStep,
  type Results,
} from '../src/lib/sillytavern/import';
import type { LoreEntry, PlotDetail, PlotMember } from '../src/lib/types';

// ── the library ─────────────────────────────────────────────────────────────

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function file(path: string, text = path): StFile {
  const bytes = encode(text);
  return { path, size: bytes.length, read: async () => bytes };
}

/** A chat file whose text the stand-in converter reads as its whole conversion. */
function chatFile(path: string, conversion: { userName?: string; messages?: number; versions?: number }): StChatFile {
  const name = path.split('/').pop()!.replace('.jsonl', '');
  return { file: file(path, JSON.stringify(conversion)), name };
}

function character(avatar: string, name: string, extra: Partial<StCharacter> = {}): StCharacter {
  return { file: file(`characters/${avatar}`), avatar, name, extraWorlds: [], chats: [], ...extra };
}

const sha = (path: string): string => `sha:${path}`;

/** Every card and chat hashed as the review's fingerprint pass would. */
function hashesOf(manifest: StManifest): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const item of manifest.characters) {
    hashes.set(item.file.path, sha(item.file.path));
    for (const chat of item.chats) hashes.set(chat.file.path, sha(chat.file.path));
  }
  for (const group of manifest.groups) {
    for (const chat of group.chats) hashes.set(chat.file.path, sha(chat.file.path));
  }
  return hashes;
}

function library({
  characters,
  groups = [],
  personas = [],
  worlds = {},
  globalWorlds = [],
  globalRegex = [],
}: {
  characters: StCharacter[];
  groups?: StGroup[];
  personas?: StPersona[];
  worlds?: Record<string, StFile>;
  globalWorlds?: string[];
  globalRegex?: unknown[];
}): StManifest {
  return { characters, groups, personas, worlds, globalWorlds, globalRegex, skipped: [] };
}

const lore = (content: string): LoreEntry =>
  ({ keys: [content], content }) as unknown as LoreEntry;

// ── the API, in memory ──────────────────────────────────────────────────────

interface FakeChat {
  id: string;
  plotId: string;
  personaId?: string;
  sha256: string;
  importing: boolean;
  messages: ImportedChatMessage[];
}

/**
 * The routes the run calls, kept as plain state. A card upload is recognized by
 * its file name, which the run sets to the ST avatar, and recorded under the
 * hash the test library gives that card — the server's own SHA-256 stands in.
 */
function fakeApi() {
  let next = 0;
  const id = (kind: string): string => `${kind}-${(next += 1)}`;
  const plots = new Map<string, PlotDetail>();
  const chats = new Map<string, FakeChat>();
  const personas: { id: string; name: string; description: string }[] = [];
  const patches: { plotId: string; body: Record<string, unknown> }[] = [];
  const uploads: { path: string; file: string; worldInfo: string | null }[] = [];
  const log: string[] = [];
  /** Requests that answer with an error instead, by `METHOD path`, consumed in order. */
  const failures = new Map<string, { status: number; code: string }[]>();
  /** Called before each request is answered; the cancel tests abort from here. */
  let before: (route: string) => void = () => undefined;

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function member(fileName: string, index: number): PlotMember {
    return {
      id: id('member'),
      name: fileName.replace('.png', ''),
      card: {} as PlotMember['card'],
      avatarUrl: null,
      orderIndex: index,
      importedFrom: { fileName, sha256: sha(`characters/${fileName}`), importedAt: '' },
      license: null,
      createdAt: '',
      updatedAt: '',
    };
  }

  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    const path = String(input);
    const route = `${method} ${path}`;
    log.push(route);
    before(route);
    init.signal?.throwIfAborted();
    const queued = failures.get(route)?.shift();
    if (queued) return json(queued.status, { error: 'stubbed', code: queued.code });

    const body = init.body;
    const read = (): Record<string, unknown> => JSON.parse(String(body)) as Record<string, unknown>;

    if (route === 'GET /api/personas') return json(200, personas);
    if (route === 'POST /api/personas') {
      const created = { id: id('persona'), ...(read() as { name: string; description: string }) };
      personas.push(created);
      return json(201, created);
    }
    if (route === 'POST /api/imports/lookup') {
      const asked = new Set(read()['sha256'] as string[]);
      const answer: ImportLookup = { characters: [], chats: [] };
      for (const plot of plots.values()) {
        for (const each of plot.characters) {
          const hash = each.importedFrom?.sha256;
          if (hash && asked.has(hash)) answer.characters.push({ sha256: hash, plotId: plot.id, characterId: each.id });
        }
      }
      for (const chat of chats.values()) {
        if (asked.has(chat.sha256)) answer.chats.push({ sha256: chat.sha256, chatId: chat.id, importing: chat.importing });
      }
      return json(200, answer);
    }
    if (route === 'POST /api/plots/import' || /^POST \/api\/plots\/[^/]+\/characters\/import$/.test(route)) {
      const form = body as FormData;
      const card = form.get('file') as File;
      const world = form.get('worldInfo') as File | null;
      uploads.push({ path, file: card.name, worldInfo: world ? await world.text() : null });
      if (path === '/api/plots/import') {
        const plotId = id('plot');
        const plot = {
          id: plotId,
          name: card.name.replace('.png', ''),
          lorebook: [lore('own')],
          customUi: { displayScripts: [{ in: 'card', out: '', order: 0, enabled: true }] },
          characters: [member(card.name, 0)],
        } as unknown as PlotDetail;
        plots.set(plotId, plot);
        return json(201, plot);
      }
      const plot = plots.get(path.split('/')[3]!)!;
      const joined = member(card.name, plot.characters.length);
      plot.characters.push(joined);
      return json(201, joined);
    }
    const plotMatch = /^(GET|PATCH) \/api\/plots\/([^/]+)$/.exec(route);
    if (plotMatch) {
      const plot = plots.get(plotMatch[2]!);
      if (!plot) return json(404, { error: 'no', code: 'not_found' });
      if (plotMatch[1] === 'PATCH') {
        patches.push({ plotId: plot.id, body: read() });
        Object.assign(plot, read());
      }
      return json(200, plot);
    }
    if (route === 'POST /api/chats/import') {
      const request = read() as { plotId: string; personaId?: string; sha256: string; messages: ImportedChatMessage[] };
      const earlier = [...chats.values()].filter((chat) => chat.sha256 === request.sha256);
      const finished = earlier.find((chat) => !chat.importing);
      if (finished) return json(409, { error: 'dup', code: 'already_imported', chatId: finished.id });
      for (const chat of earlier) chats.delete(chat.id);
      const chat: FakeChat = {
        id: id('chat'),
        plotId: request.plotId,
        ...(request.personaId ? { personaId: request.personaId } : {}),
        sha256: request.sha256,
        importing: true,
        messages: [...request.messages],
      };
      chats.set(chat.id, chat);
      return json(201, { chat: { id: chat.id }, inserted: request.messages.length });
    }
    const chatMatch = /^POST \/api\/chats\/([^/]+)\/import(\/complete)?$/.exec(route);
    if (chatMatch) {
      const chat = chats.get(chatMatch[1]!)!;
      if (chatMatch[2]) {
        chat.importing = false;
        return json(200, { chat: { id: chat.id }, memoryBackfill: read()['backfillMemory'] ? 'queued' : 'not_needed' });
      }
      chat.messages.push(...(read()['messages'] as ImportedChatMessage[]));
      return json(200, { inserted: 1, total: chat.messages.length });
    }
    return json(500, { error: `unrouted ${route}`, code: 'internal_error' });
  });

  return {
    fetch,
    plots,
    chats,
    personas,
    patches,
    uploads,
    log,
    failures,
    setBefore: (hook: (route: string) => void) => {
      before = hook;
    },
    /** The writes, with the reads and the lookups left out. */
    writes: () =>
      log.filter((route) => !route.startsWith('GET ') && route !== 'POST /api/imports/lookup'),
  };
}

type Api = ReturnType<typeof fakeApi>;

/** The stand-in converter: the file says how many messages it holds and whose. */
function deps(api: Api): ImportDeps & { casts: { members: { name: string; avatar?: string }[] }[] } {
  const casts: { members: { name: string; avatar?: string }[] }[] = [];
  return {
    fetch: api.fetch as unknown as typeof fetch,
    casts,
    convertChat: (text, cast) => {
      casts.push(cast);
      const { userName = '', messages = 2, versions = 1 } = JSON.parse(text) as {
        userName?: string;
        messages?: number;
        versions?: number;
      };
      return {
        userName,
        characterName: '',
        messages: Array.from({ length: messages }, (_, index) => ({
          role: index % 2 ? 'user' : 'assistant',
          versions: Array.from({ length: versions }, (__, version) => `line ${index}.${version}`),
          selected: 0,
        })),
        skipped: { hidden: 1, empty: 0, unknownSpeaker: 0, malformed: 0, overLimit: 0 },
      };
    },
    lorebookEntries: (json) => (json as { entries: string[] }).entries.map(lore),
    displayScripts: (scripts) =>
      scripts.map((script, order) => ({ in: String(script), out: '', order, enabled: true })),
  };
}

/** What a run is given: the plan, and every card of the library as the page passes it. */
const inputOf = (manifest: StManifest, steps: ImportStep[], options: ImportOptions = DEFAULT_OPTIONS) => ({
  manifest,
  steps,
  options,
  cardHashes: manifest.characters.map((item) => sha(item.file.path)),
});

/** Scans nothing: the review is made from the library and the API's current state. */
async function reviewOf(api: Api, manifest: StManifest) {
  const hashes = hashesOf(manifest);
  const lookup = (await (await api.fetch('/api/imports/lookup', {
    method: 'POST',
    body: JSON.stringify({ sha256: [...hashes.values()] }),
  })).json()) as ImportLookup;
  const personas = (await (await api.fetch('/api/personas')).json()) as { name: string }[];
  api.log.length = 0;
  return reviewImport(manifest, hashes, lookup, personas.map((persona) => persona.name));
}

async function runAll(
  api: Api,
  manifest: StManifest,
  options: ImportOptions = DEFAULT_OPTIONS,
  extra: { signal?: AbortSignal } = {},
) {
  const review = await reviewOf(api, manifest);
  const steps = planImport(review, defaultSelection(review), options);
  const dependencies = deps(api);
  const results = await runImport(inputOf(manifest, steps, options), initialResults(steps), dependencies, extra);
  return { review, steps, results, dependencies };
}

/** Alice links a world and has one extra; Bob is plain; both are in one group. */
function sample(): StManifest {
  const alice = character('Alice.png', 'Alice', {
    worldName: 'Wonderland',
    extraWorlds: ['Tea'],
    chats: [chatFile('chats/Alice/one.jsonl', { userName: 'Kim', messages: 3 })],
  });
  const bob = character('Bob.png', 'Bob', {
    chats: [chatFile('chats/Bob/two.jsonl', { userName: '', messages: 1 })],
  });
  return library({
    characters: [alice, bob],
    groups: [
      {
        id: 'g1',
        name: 'Tea party',
        members: ['Alice.png', 'Bob.png', 'Ghost.png'],
        chats: [chatFile('group chats/party.jsonl', { userName: 'Kim', messages: 2 })],
      },
    ],
    personas: [{ avatar: 'kim.png', name: 'Kim', description: 'a reader' }],
    worlds: {
      Wonderland: file('worlds/Wonderland.json', JSON.stringify({ entries: ['rabbit'] })),
      Tea: file('worlds/Tea.json', JSON.stringify({ entries: ['tea'] })),
      Global: file('worlds/Global.json', JSON.stringify({ entries: ['everywhere'] })),
    },
    globalWorlds: ['Global'],
    globalRegex: ['/x/'],
  });
}

// ── batching ────────────────────────────────────────────────────────────────

const message = (text: string, versions = 1, selected = 0): ImportedChatMessage => ({
  role: 'assistant',
  versions: Array.from({ length: versions }, (_, index) => `${text}#${index}`),
  selected,
});

describe('batchMessages', () => {
  it('cuts at the message cap', () => {
    const batches = batchMessages(Array.from({ length: 1201 }, (_, index) => message(String(index))));
    expect(batches.map((batch) => batch.length)).toEqual([BATCH_MESSAGES, BATCH_MESSAGES, 201]);
  });

  it('cuts where the JSON would pass the byte cap, and keeps an oversized message alone', () => {
    const big = message('x'.repeat(900));
    const size = JSON.stringify(big).length;
    const batches = batchMessages([big, big, big, message('y'.repeat(5000)), big], {
      maxBytes: 2 + size * 2 + 1,
    });
    expect(batches.map((batch) => batch.length)).toEqual([2, 1, 1, 1]);
    for (const batch of batches.slice(0, 2)) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(2 + size * 2 + 1);
    }
  });

  it('measures UTF-8 bytes rather than characters', () => {
    const korean = message('가'.repeat(100));
    const bytes = new TextEncoder().encode(JSON.stringify(korean)).length;
    expect(batchMessages([korean, korean], { maxBytes: bytes + 10 })).toHaveLength(2);
  });
});

describe('capVersions', () => {
  it('keeps the first twenty when the selected swipe is among them', () => {
    const { message: capped, dropped } = capVersions(message('m', 25, 5));
    expect(capped.versions).toHaveLength(20);
    expect(capped.versions[capped.selected]).toBe('m#5');
    expect(capped.versions[19]).toBe('m#19');
    expect(dropped).toBe(5);
  });

  it('keeps a selected swipe past twenty and drops others for it', () => {
    const { message: capped } = capVersions(message('m', 30, 27));
    expect(capped.versions).toHaveLength(20);
    expect(capped.versions[capped.selected]).toBe('m#27');
    expect(capped.versions.slice(0, 19)).toEqual(Array.from({ length: 19 }, (_, index) => `m#${index}`));
  });
});

// ── review and plan ─────────────────────────────────────────────────────────

describe('the review', () => {
  it('caps a group at ten members, naming who is left out and who has no card', () => {
    const cast = Array.from({ length: 12 }, (_, index) => character(`c${index}.png`, `C${index}`));
    const manifest = library({
      characters: cast,
      groups: [{ id: 'big', name: 'Big', members: [...cast.map((item) => item.avatar), 'gone.png'], chats: [] }],
    });
    const review = reviewImport(manifest, hashesOf(manifest), { characters: [], chats: [] }, []);
    const [group] = review.groups;
    expect(group!.members.map((item) => item.character.name)).toEqual(cast.slice(0, 10).map((item) => item.name));
    expect(group!.overflow).toEqual(['C10', 'C11']);
    expect(group!.missing).toEqual(['gone.png']);
  });

  it('tells a character’s own plot from the group plots its card is also in', () => {
    const manifest = sample();
    const lookup: ImportLookup = {
      characters: [
        { sha256: sha('characters/Alice.png'), plotId: 'group-plot', characterId: 'a2' },
        { sha256: sha('characters/Bob.png'), plotId: 'group-plot', characterId: 'b2' },
      ],
      chats: [{ sha256: sha('group chats/party.jsonl'), chatId: 'c9', importing: true }],
    };
    const review = reviewImport(manifest, hashesOf(manifest), lookup, ['Kim']);
    expect(review.characters.map((item) => item.plotId)).toEqual([null, null]);
    expect(review.groups[0]!.plotId).toBe('group-plot');
    expect(review.groups[0]!.chats[0]!.state).toBe('incomplete');
    expect(review.personas[0]!.exists).toBe(true);

    const selection = defaultSelection(review);
    expect([...selection.characters]).toEqual(['Alice.png', 'Bob.png']);
    // The group plot is there, but a chat of it never finished.
    expect([...selection.groups]).toEqual(['g1']);
    expect([...selection.personas]).toEqual([]);
  });

  it('flags a name that cannot open a speaker line', () => {
    const manifest = library({
      characters: [character('a.png', 'Dr: Who'), character('b.png', 'B'.repeat(41)), character('c.png', 'Fine')],
    });
    const review = reviewImport(manifest, hashesOf(manifest), { characters: [], chats: [] }, []);
    expect(review.characters.map((item) => item.unspeakable)).toEqual([true, true, false]);
  });
});

describe('planImport', () => {
  it('orders personas, then each character with its chats, then each group with its', async () => {
    const api = fakeApi();
    const review = await reviewOf(api, sample());
    const steps = planImport(review, defaultSelection(review), DEFAULT_OPTIONS);
    expect(steps.map((step) => step.id)).toEqual([
      'persona:kim.png',
      'character:Alice.png',
      'chat:chats/Alice/one.jsonl',
      'character:Bob.png',
      'chat:chats/Bob/two.jsonl',
      'group:g1',
      'chat:group chats/party.jsonl',
    ]);
    expect(planImport(review, defaultSelection(review), { ...DEFAULT_OPTIONS, chats: false }).map((step) => step.kind)).toEqual([
      'persona',
      'character',
      'character',
      'group',
    ]);
  });
});

// ── the run ─────────────────────────────────────────────────────────────────

describe('runImport', () => {
  it('brings everything over in dependency order', async () => {
    const api = fakeApi();
    const manifest = sample();
    const { results, dependencies } = await runAll(api, manifest, {
      ...DEFAULT_OPTIONS,
      globalLorebooks: true,
      globalRegex: true,
    });

    expect(api.writes()).toEqual([
      'POST /api/personas',
      'POST /api/plots/import',
      'PATCH /api/plots/plot-2',
      'POST /api/chats/import',
      'POST /api/chats/chat-4/import/complete',
      'POST /api/plots/import',
      'PATCH /api/plots/plot-5',
      'POST /api/chats/import',
      'POST /api/chats/chat-7/import/complete',
      'POST /api/plots/import',
      'PATCH /api/plots/plot-8',
      'POST /api/plots/plot-8/characters/import',
      'POST /api/chats/import',
      'POST /api/chats/chat-11/import/complete',
    ]);
    expect(Object.values(results).every((result) => result.status === 'done')).toBe(true);

    // The linked world rides with Alice's card, both times; Bob has none.
    expect(api.uploads.map((upload) => [upload.file, upload.worldInfo !== null])).toEqual([
      ['Alice.png', true],
      ['Bob.png', false],
      ['Alice.png', true],
      ['Bob.png', false],
    ]);
    // Alice's plot: its own lore, then her extra book, then the global one — and
    // the global regex after the card's own display script.
    const alice = api.patches[0]!.body;
    expect((alice['lorebook'] as LoreEntry[]).map((entry) => entry.content)).toEqual(['own', 'tea', 'everywhere']);
    expect((alice['customUi'] as { displayScripts: { in: string }[] }).displayScripts.map((script) => script.in)).toEqual([
      'card',
      '/x/',
    ]);
    expect(alice['name']).toBeUndefined();
    // The group's plot takes the group's name.
    expect(api.patches[2]!.body['name']).toBe('Tea party');

    // Each chat is converted against its plot's cast; the group chat against both.
    expect(dependencies.casts).toEqual([
      { members: [{ name: 'Alice', avatar: 'Alice.png' }] },
      { members: [{ name: 'Bob', avatar: 'Bob.png' }] },
      { members: [{ name: 'Alice', avatar: 'Alice.png' }, { name: 'Bob', avatar: 'Bob.png' }] },
    ]);
    // A chat written as Kim starts on the Kim persona the run made; one that names
    // nobody starts on none.
    const [kim] = api.personas;
    const byPlot = new Map([...api.chats.values()].map((chat) => [chat.plotId, chat]));
    expect(byPlot.get('plot-2')!.personaId).toBe(kim!.id);
    expect(byPlot.get('plot-5')!.personaId).toBeUndefined();
    expect(byPlot.get('plot-8')!.personaId).toBe(kim!.id);
    expect(results['chat:chats/Alice/one.jsonl']!.memoryBackfill).toBe('queued');
    expect(results['chat:chats/Alice/one.jsonl']!.dropped).toMatchObject({ hidden: 1, swipes: 0 });
  });

  it('leaves the global lorebooks and regex alone by default', async () => {
    const api = fakeApi();
    await runAll(api, sample());
    const alice = api.patches[0]!.body;
    expect((alice['lorebook'] as LoreEntry[]).map((entry) => entry.content)).toEqual(['own', 'tea']);
    expect(alice['customUi']).toBeUndefined();
  });

  it('finds everything a second time and makes nothing twice', async () => {
    const api = fakeApi();
    const manifest = sample();
    await runAll(api, manifest);
    const plots = api.plots.size;
    const chats = api.chats.size;

    const review = await reviewOf(api, manifest);
    expect(review.characters.every((item) => item.plotId !== null)).toBe(true);
    expect(review.groups[0]!.plotId).not.toBeNull();
    expect(review.personas[0]!.exists).toBe(true);
    const selection = defaultSelection(review);
    expect(selection.characters.size + selection.groups.size + selection.personas.size).toBe(0);

    // Even everything ticked by hand only reads.
    const everything = {
      characters: new Set(review.characters.map((item) => item.key)),
      groups: new Set(review.groups.map((item) => item.key)),
      personas: new Set(review.personas.map((item) => item.key)),
    };
    const steps = planImport(review, everything, DEFAULT_OPTIONS);
    const results = await runImport(inputOf(manifest, steps), initialResults(steps), deps(api));
    expect(api.writes()).toEqual([]);
    expect(Object.values(results).map((result) => result.reason)).toEqual([
      'already_imported',
      'already_imported',
      'already_imported',
    ]);
    expect(api.plots.size).toBe(plots);
    expect(api.chats.size).toBe(chats);
  });

  it('does not take a group’s plot for a member’s own when only the member is imported later', async () => {
    const api = fakeApi();
    const manifest = sample();
    const review = await reviewOf(api, manifest);
    const groupOnly = { characters: new Set<string>(), groups: new Set(['g1']), personas: new Set<string>() };
    const steps = planImport(review, groupOnly, DEFAULT_OPTIONS);
    await runImport(inputOf(manifest, steps), initialResults(steps), deps(api));
    expect(api.plots.size).toBe(1);

    // Alice alone, in a run that has nothing else of the group in it.
    const later = await reviewOf(api, manifest);
    expect(later.characters[0]!.plotId).toBeNull();
    const aliceOnly = { characters: new Set(['Alice.png']), groups: new Set<string>(), personas: new Set<string>() };
    const next = planImport(later, aliceOnly, DEFAULT_OPTIONS);
    const results = await runImport(inputOf(manifest, next), initialResults(next), deps(api));
    expect(results['character:Alice.png']!.status).toBe('done');
    expect(api.plots.size).toBe(2);
    expect([...api.chats.values()].at(-1)!.plotId).toBe(results['character:Alice.png']!.plotId);
  });

  it('brings a new chat into the plot an earlier run made', async () => {
    const api = fakeApi();
    const manifest = sample();
    await runAll(api, manifest);
    manifest.characters[1]!.chats.push(chatFile('chats/Bob/three.jsonl', { messages: 4 }));
    const hashesBefore = api.chats.size;

    const { results } = await runAll(api, manifest);
    expect(api.writes()).toEqual(['POST /api/chats/import', 'POST /api/chats/chat-12/import/complete']);
    expect(results['character:Bob.png']).toMatchObject({ status: 'skipped', reason: 'already_imported', plotId: 'plot-5' });
    expect([...api.chats.values()].at(-1)!.plotId).toBe('plot-5');
    expect(api.chats.size).toBe(hashesBefore + 1);
  });

  it('makes no persona the account already has by name, and maps chats to the one it has', async () => {
    const api = fakeApi();
    api.personas.push({ id: 'mine', name: 'Kim', description: '' });
    await runAll(api, sample());
    expect(api.log).not.toContain('POST /api/personas');
    expect([...api.chats.values()][0]!.personaId).toBe('mine');
  });

  it('checks persona names again at run time', async () => {
    const api = fakeApi();
    const manifest = sample();
    const review = await reviewOf(api, manifest);
    const steps = planImport(review, defaultSelection(review), DEFAULT_OPTIONS);
    // Made elsewhere between the review and the run.
    api.personas.push({ id: 'meanwhile', name: 'Kim', description: '' });
    const results = await runImport(inputOf(manifest, steps), initialResults(steps), deps(api));
    expect(results['persona:kim.png']).toMatchObject({ status: 'skipped', reason: 'persona_exists' });
    expect(api.personas).toHaveLength(1);
    expect([...api.chats.values()][0]!.personaId).toBe('meanwhile');
  });

  it('cuts a long chat into batches and its swipes into the cap', async () => {
    const api = fakeApi();
    const manifest = library({
      characters: [character('A.png', 'A', { chats: [chatFile('chats/A/long.jsonl', { messages: 1100, versions: 18 })] })],
    });
    await runAll(api, manifest);
    expect(api.writes()).toEqual([
      'POST /api/plots/import',
      'POST /api/chats/import',
      'POST /api/chats/chat-3/import',
      'POST /api/chats/chat-3/import',
      'POST /api/chats/chat-3/import/complete',
    ]);
    expect([...api.chats.values()][0]!.messages).toHaveLength(1100);

    const swiped = fakeApi();
    const wide = library({
      characters: [character('A.png', 'A', { chats: [chatFile('chats/A/wide.jsonl', { messages: 900, versions: 22 })] })],
    });
    const { results } = await runAll(swiped, wide);
    const chat = [...swiped.chats.values()][0]!;
    expect(chat.messages.every((each) => each.versions.length === 20)).toBe(true);
    expect(results['chat:chats/A/wide.jsonl']!.dropped).toMatchObject({ swipes: 900 * 2, swipesOverRows: 0 });
  });

  it('fits a chat over the row cap by letting the oldest swipes go', async () => {
    const api = fakeApi();
    // 1001 × 20 = 20,020 rows: twenty too many.
    const manifest = library({
      characters: [character('A.png', 'A', { chats: [chatFile('chats/A/huge.jsonl', { messages: 1001, versions: 20 })] })],
    });
    const { results } = await runAll(api, manifest);
    expect(results['chat:chats/A/huge.jsonl']!.status).toBe('done');
    expect(results['chat:chats/A/huge.jsonl']!.dropped!.swipesOverRows).toBe(20);
    const chat = [...api.chats.values()][0]!;
    expect(chat.messages.map((each) => each.versions.length).slice(0, 3)).toEqual([1, 19, 20]);
    expect(chat.messages.reduce((rows, each) => rows + each.versions.length, 0)).toBe(20_000);
    expect(chat.messages.every((each) => each.versions[each.selected] === each.versions[0])).toBe(true);
  });

  it('refuses a chat whose selected path alone is over the row cap, before writing', () => {
    expect(fitRows([message('a', 3, 2), message('b', 2, 1)], 3)).toEqual({
      messages: [
        { role: 'assistant', versions: ['a#2'], selected: 0 },
        { role: 'assistant', versions: ['b#0', 'b#1'], selected: 1 },
      ],
      dropped: 2,
    });
    expect(fitRows([message('a'), message('b'), message('c')], 2)).toBeUndefined();
  });

  it('stops sending chats once there is no model to put them on, and goes on with the cards', async () => {
    const api = fakeApi();
    api.failures.set('POST /api/chats/import', [{ status: 400, code: 'model_unavailable' }]);
    const { results } = await runAll(api, sample());
    expect(api.log.filter((route) => route === 'POST /api/chats/import')).toHaveLength(1);
    for (const id of ['chat:chats/Alice/one.jsonl', 'chat:chats/Bob/two.jsonl', 'chat:group chats/party.jsonl']) {
      expect(results[id]!.status).toBe('failed');
      expect(results[id]!.error!.code).toBe('model_unavailable');
    }
    expect(results['character:Bob.png']!.status).toBe('done');
    expect(results['group:g1']!.status).toBe('done');
  });

  it('records a failure and goes on; its chats wait, and a retry brings both', async () => {
    const api = fakeApi();
    const manifest = sample();
    api.failures.set('POST /api/plots/import', [{ status: 500, code: 'internal_error' }]);
    const review = await reviewOf(api, manifest);
    const steps = planImport(review, defaultSelection(review), DEFAULT_OPTIONS);
    const dependencies = deps(api);
    const first = await runImport(inputOf(manifest, steps), initialResults(steps), dependencies);

    expect(first['character:Alice.png']).toMatchObject({ status: 'failed' });
    expect(first['character:Alice.png']!.error).toBeInstanceOf(ApiError);
    expect(first['chat:chats/Alice/one.jsonl']).toMatchObject({ status: 'skipped', reason: 'owner_failed' });
    expect(first['character:Bob.png']!.status).toBe('done');
    expect(first['group:g1']!.status).toBe('done');

    api.log.length = 0;
    const second = await runImport(inputOf(manifest, steps), first, dependencies);
    // Alice's card also sits in the group's plot now; that is not hers alone.
    expect(api.writes()).toEqual([
      'POST /api/plots/import',
      'PATCH /api/plots/plot-9',
      'POST /api/chats/import',
      'POST /api/chats/chat-11/import/complete',
    ]);
    expect(Object.values(second).every((result) => result.status === 'done')).toBe(true);
  });

  it('a retry after a lost response finds the plot the server made', async () => {
    const api = fakeApi();
    const manifest = library({ characters: [character('A.png', 'A')] });
    const review = await reviewOf(api, manifest);
    const steps = planImport(review, defaultSelection(review), DEFAULT_OPTIONS);
    const dependencies = deps(api);
    // The plot is made, and the answer never arrives.
    const real = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementationOnce(real).mockImplementationOnce(real).mockImplementationOnce(async (input, init) => {
      await real(input, init);
      throw new TypeError('Failed to fetch');
    });
    const first = await runImport(inputOf(manifest, steps), initialResults(steps), dependencies);
    expect(first['character:A.png']!.status).toBe('failed');
    expect(api.plots.size).toBe(1);

    const second = await runImport(inputOf(manifest, steps), first, dependencies);
    expect(second['character:A.png']).toMatchObject({ status: 'skipped', reason: 'already_imported' });
    expect(api.plots.size).toBe(1);
  });

  it('stops on cancel, and a retry picks up where it stopped', async () => {
    const api = fakeApi();
    const manifest = library({
      characters: [
        character('A.png', 'A', { chats: [chatFile('chats/A/long.jsonl', { messages: 1200 })] }),
        character('B.png', 'B'),
      ],
    });
    const review = await reviewOf(api, manifest);
    const steps = planImport(review, defaultSelection(review), DEFAULT_OPTIONS);
    const controller = new AbortController();
    // Mid-chat: after the create, before the second batch lands.
    api.setBefore((route) => {
      if (/\/api\/chats\/[^/]+\/import$/.test(route)) controller.abort();
    });
    const updates: Results[] = [];
    const first = await runImport(inputOf(manifest, steps), initialResults(steps), deps(api), {
      signal: controller.signal,
      onUpdate: (results) => updates.push(results),
    });
    expect(first['character:A.png']!.status).toBe('done');
    expect(first['chat:chats/A/long.jsonl']!.status).toBe('cancelled');
    expect(first['character:B.png']!.status).toBe('cancelled');
    expect(updates.at(-1)).toEqual(first);
    // Left open on the server; B never went.
    expect([...api.chats.values()].map((chat) => chat.importing)).toEqual([true]);
    expect(api.uploads.map((upload) => upload.file)).toEqual(['A.png']);

    api.setBefore(() => undefined);
    api.log.length = 0;
    const second = await runImport(inputOf(manifest, steps), first, deps(api));
    // The character is not made again; the chat starts over (the create replaces
    // the half-written one) and B comes after.
    expect(api.writes()).toEqual([
      'POST /api/chats/import',
      'POST /api/chats/chat-4/import',
      'POST /api/chats/chat-4/import',
      'POST /api/chats/chat-4/import/complete',
      'POST /api/plots/import',
    ]);
    expect(Object.values(second).every((result) => result.status === 'done')).toBe(true);
    expect([...api.chats.values()].map((chat) => [chat.importing, chat.messages.length])).toEqual([[false, 1200]]);
  });

  it('skips a chat an earlier run finished even when the lookup missed it', async () => {
    const api = fakeApi();
    const manifest = library({ characters: [character('A.png', 'A', { chats: [chatFile('chats/A/x.jsonl', {})] })] });
    const review = await reviewOf(api, manifest);
    const steps = planImport(review, defaultSelection(review), DEFAULT_OPTIONS);
    api.chats.set('elsewhere', {
      id: 'elsewhere',
      plotId: 'p',
      sha256: sha('chats/A/x.jsonl'),
      importing: false,
      messages: [],
    });
    // The run's own lookup sees it too, so it is skipped before the create.
    const results = await runImport(inputOf(manifest, steps), initialResults(steps), deps(api));
    expect(results['chat:chats/A/x.jsonl']).toMatchObject({ status: 'skipped', chatId: 'elsewhere' });

    // And the create's own 409 says the same when the lookup did not.
    api.chats.delete('elsewhere');
    const again = await runImport(
      inputOf(manifest, steps),
      { ...results, 'chat:chats/A/x.jsonl': { status: 'pending' } },
      {
        ...deps(api),
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
          String(input) === '/api/chats/import'
            ? new Response(JSON.stringify({ error: 'dup', code: 'already_imported', chatId: 'raced' }), { status: 409 })
            : api.fetch(input, init)) as typeof fetch,
      },
    );
    expect(again['chat:chats/A/x.jsonl']).toMatchObject({ status: 'skipped', reason: 'already_imported', chatId: 'raced' });
  });

  it('sends the card again without its linked world when the API cannot read the world', async () => {
    const api = fakeApi();
    const manifest = sample();
    manifest.groups = [];
    api.failures.set('POST /api/plots/import', [{ status: 400, code: 'invalid_lorebook' }]);
    const { results } = await runAll(api, manifest);
    expect(api.uploads[0]).toMatchObject({ file: 'Alice.png', worldInfo: null });
    expect(results['character:Alice.png']!.status).toBe('done');
    expect(results['character:Alice.png']!.warnings).toEqual([{ code: 'world_unreadable', name: 'Wonderland' }]);
  });

  it('sends the card without its linked world when the world file cannot be read here', async () => {
    const api = fakeApi();
    const manifest = sample();
    manifest.groups = [];
    manifest.worlds['Wonderland'] = { path: 'worlds/Wonderland.json', size: 10, read: () => Promise.reject(new Error('corrupt')) };
    const { results } = await runAll(api, manifest);
    expect(api.uploads[0]).toMatchObject({ file: 'Alice.png', worldInfo: null });
    expect(results['character:Alice.png']!.status).toBe('done');
    expect(results['character:Alice.png']!.warnings).toEqual([{ code: 'world_unreadable', name: 'Wonderland' }]);
  });

  it('refuses a chat with a message over the length cap before writing any of it', async () => {
    const api = fakeApi();
    const manifest = library({ characters: [character('A.png', 'A', { chats: [chatFile('chats/A/x.jsonl', {})] })] });
    const dependencies = deps(api);
    const convert = dependencies.convertChat;
    dependencies.convertChat = (text, cast) => {
      const converted = convert(text, cast);
      converted.messages[0]!.versions[0] = 'x'.repeat(100_001);
      return converted;
    };
    const review = await reviewOf(api, manifest);
    const steps = planImport(review, defaultSelection(review), DEFAULT_OPTIONS);
    const results = await runImport(inputOf(manifest, steps), initialResults(steps), dependencies);
    expect(results['chat:chats/A/x.jsonl']!.error!.code).toBe('message_too_long');
    expect(api.log).not.toContain('POST /api/chats/import');
  });

  it('keeps a group’s plot when a member fails, and a retry adds only that member', async () => {
    const api = fakeApi();
    const manifest = sample();
    manifest.characters.forEach((item) => (item.chats = []));
    const review = await reviewOf(api, manifest);
    const selection = { ...defaultSelection(review), characters: new Set<string>(), personas: new Set<string>() };
    const steps = planImport(review, selection, DEFAULT_OPTIONS);
    api.failures.set('POST /api/plots/plot-1/characters/import', [{ status: 500, code: 'internal_error' }]);
    const dependencies = deps(api);
    const first = await runImport(inputOf(manifest, steps), initialResults(steps), dependencies);
    expect(first['group:g1']).toMatchObject({ status: 'failed', plotId: 'plot-1' });
    expect(first['chat:group chats/party.jsonl']).toMatchObject({ status: 'skipped', reason: 'owner_failed' });

    api.log.length = 0;
    const second = await runImport(inputOf(manifest, steps), first, dependencies);
    expect(api.writes()).toEqual([
      'POST /api/plots/plot-1/characters/import',
      'POST /api/chats/import',
      'POST /api/chats/chat-4/import/complete',
    ]);
    expect(api.plots.size).toBe(1);
    expect(api.plots.get('plot-1')!.characters.map((each) => each.name)).toEqual(['Alice', 'Bob']);
    expect(second['group:g1']!.status).toBe('done');
  });
});

// ── what is read ────────────────────────────────────────────────────────────

describe('the picked files', () => {
  it('leave the key store out of a folder pick', () => {
    // Node's File has no `webkitRelativePath`; a folder pick's files carry one.
    const picked = ['default-user/settings.json', 'default-user/secrets.json', 'default-user/characters/A.png'].map(
      (path) =>
        Object.defineProperty(new File(['x'], path.split('/').pop()!), 'webkitRelativePath', { value: path }),
    );
    expect(folderFiles(picked).map((item) => item.relativePath)).toEqual([
      'default-user/settings.json',
      'default-user/characters/A.png',
    ]);
  });

  it('refuse to read secrets.json whatever the list says', async () => {
    const [secrets, card] = guardFiles([file('secrets.json', '{"api_key":"k"}'), file('characters/A.png')]);
    await expect(secrets!.read()).rejects.toThrow();
    await expect(card!.read()).resolves.toBeInstanceOf(Uint8Array);
  });
});

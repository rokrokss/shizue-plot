/**
 * The embedding worker over a stand-in for transformers.js: which model it
 * loads for each batch, with RisuAI's options, and how it moves from one model
 * to the next. That the real pipeline answers to these options is checked
 * outside the suite, against the real model in Node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Extractor {
  (texts: string[], options: unknown): Promise<{ data: Float32Array }>;
  dispose: () => Promise<void>;
}

/** Everything the worker did, in order: `load:<repo>`, `run:<repo>:<texts>`, `dispose:<repo>`. */
let log: string[];
let loadOptions: unknown[];
let runOptions: unknown[];
/** Repos whose next load fails. */
let failing: Set<string>;
/** Holds every load until released, so a test can line batches up behind one. */
let gate: Promise<void>;

const env = { backends: { onnx: { wasm: { wasmPaths: 'https://cdn.example/' as string | undefined } } } };

vi.mock('@huggingface/transformers', () => ({
  env,
  pipeline: async (task: string, repo: string, options: unknown) => {
    expect(task).toBe('feature-extraction');
    log.push(`load:${repo}`);
    loadOptions.push(options);
    await gate;
    if (failing.delete(repo)) throw new Error(`could not fetch ${repo}`);
    const extractor = (async (texts: string[], run: unknown) => {
      log.push(`run:${repo}:${texts.join(',')}`);
      runOptions.push(run);
      // Two numbers per text: its length and which batch position it held.
      return { data: Float32Array.from(texts.flatMap((text, at) => [text.length, at])) };
    }) as Extractor;
    extractor.dispose = async () => void log.push(`dispose:${repo}`);
    return extractor;
  },
}));

/** What the worker posted back, by id. */
let answers: Map<number, { vectors?: Float32Array[]; error?: string }>;
let scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };

let seq: number;

/** A fresh worker, as a new page would start. */
beforeEach(async () => {
  log = [];
  loadOptions = [];
  runOptions = [];
  failing = new Set();
  gate = Promise.resolve();
  answers = new Map();
  seq = 0;
  env.backends.onnx.wasm.wasmPaths = 'https://cdn.example/';
  scope = {
    onmessage: null,
    postMessage: (message) => {
      const { id, ...rest } = message as { id: number; vectors?: Float32Array[]; error?: string };
      answers.set(id, rest);
    },
  };
  vi.stubGlobal('self', scope);
  vi.resetModules();
  await import('../src/lib/scripts/embeddingWorker');
});

afterEach(() => vi.unstubAllGlobals());

const SMALL = 'Xenova/all-MiniLM-L6-v2';
const MULTI = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

/** Posts a batch as the page does. */
function post(model: string, texts: string[]): number {
  seq += 1;
  scope.onmessage!({ data: { id: seq, model, texts } });
  return seq;
}
/** Once every batch posted is answered. */
const settled = () => vi.waitFor(() => expect(answers.size).toBe(seq));

describe('the embedding worker', () => {
  it('runs onnxruntime from the build, never from a CDN', () => {
    expect(env.backends.onnx.wasm.wasmPaths).toBeUndefined();
  });

  it('loads the model each batch names, with RisuAI’s options, once, and slices out each text’s vector', async () => {
    const a = post(MULTI, ['검', '방패']);
    const b = post(MULTI, ['활']);
    await settled();
    expect(log).toEqual([`load:${MULTI}`, `run:${MULTI}:검,방패`, `run:${MULTI}:활`]);
    expect(loadOptions).toEqual([{ dtype: 'q8', device: 'wasm' }]);
    expect(runOptions).toEqual([
      { pooling: 'mean', normalize: true },
      { pooling: 'mean', normalize: true },
    ]);
    expect(answers.get(a)).toEqual({ vectors: [Float32Array.of(1, 0), Float32Array.of(2, 1)] });
    expect(answers.get(b)).toEqual({ vectors: [Float32Array.of(1, 0)] });
  });

  it('lets one model go before it loads the next, as RisuAI does, and never under a batch still running', async () => {
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    // All three are posted while the first load is still downloading.
    post(SMALL, ['a']);
    post(MULTI, ['b']);
    post(SMALL, ['c']);
    release();
    await settled();
    expect(log).toEqual([
      `load:${SMALL}`,
      `run:${SMALL}:a`,
      `dispose:${SMALL}`,
      `load:${MULTI}`,
      `run:${MULTI}:b`,
      `dispose:${MULTI}`,
      `load:${SMALL}`,
      `run:${SMALL}:c`,
    ]);
    expect([...answers.values()].every((answer) => answer.vectors)).toBe(true);
  });

  it('answers a load that failed with its error, and tries the model again on the next batch', async () => {
    failing.add(MULTI);
    const lost = post(MULTI, ['a']);
    const kept = post(MULTI, ['b']);
    await settled();
    expect(answers.get(lost)).toEqual({ error: `could not fetch ${MULTI}` });
    expect(answers.get(kept)?.vectors).toHaveLength(1);
    expect(log).toEqual([`load:${MULTI}`, `load:${MULTI}`, `run:${MULTI}:b`]);
  });
});

/**
 * A file import over the wire (`lib/fileImport`), against the in-memory stand-in
 * for `/api/file-imports` and its store: what is sent where, what the screen is
 * told on the way, and what a dropped part, an expired address, a part the
 * store lost, a failed import, a module's low-level access and an abort each
 * come to. The browser's own part PUT is checked against a stand-in XHR.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import {
  confirmImport,
  FileImportError,
  importFile,
  xhrPut,
  type FileImportTransport,
  type ImportProgress,
  type PartPut,
} from '../src/lib/fileImport';
import { fakeFileImports, type FakeFileImportOptions } from './fileImportFake';

const made = { id: 'plot-1', name: '여관', importWarnings: [] };

function setup(options: Partial<FakeFileImportOptions> = {}) {
  const jobs: { body: Record<string, unknown>; text: string }[] = [];
  const api = fakeFileImports({
    job: ({ body, text }) => {
      jobs.push({ body, text });
      return { result: made };
    },
    ...options,
  });
  const sleep = vi.fn(async (_ms: number) => undefined);
  const transport = (put: PartPut = api.put): Partial<FileImportTransport> => ({
    fetch: api.fetch as unknown as typeof fetch,
    put,
    sleep,
  });
  const routes = () => api.fetch.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`);
  return { api, jobs, sleep, transport, routes };
}

const file = (text = 'abcdefghij', name = 'sei.charx') => new File([text], name);

describe('importFile', () => {
  it('starts the import with what rides beside the file, sends each part as its slice, and answers what the import made', async () => {
    const { api, jobs, transport, routes } = setup();
    const result = await importFile('member', file(), { plotId: 'plot-1', rightsConfirmed: true, sourceUrl: 'https://realm.risuai.net/character/x' }, {
      transport: transport(),
    });

    expect(result).toEqual(made);
    expect(jobs).toEqual([
      {
        body: {
          target: 'member',
          fileName: 'sei.charx',
          size: 10,
          plotId: 'plot-1',
          rightsConfirmed: true,
          sourceUrl: 'https://realm.risuai.net/character/x',
        },
        text: 'abcdefghij',
      },
    ]);
    // Four bytes a part here: the last is what is left.
    const sent = await Promise.all(
      api.put.mock.calls.map(async ([url, blob]) => [url, await blob.text(), blob.type] as const),
    );
    expect(sent.sort()).toEqual([
      ['/api/file-imports/import-1/parts/1', 'abcd', ''],
      ['/api/file-imports/import-1/parts/2', 'efgh', ''],
      ['/api/file-imports/import-1/parts/3', 'ij', ''],
    ]);
    expect(routes()).toEqual([
      'POST /api/file-imports',
      'POST /api/file-imports/import-1/parts',
      'POST /api/file-imports/import-1/complete',
      'GET /api/file-imports/import-1',
    ]);
  });

  it('says how much has gone up, then where the server is with it', async () => {
    const { transport } = setup({ processingPolls: 1 });
    const progress: ImportProgress[] = [];
    await importFile('plot', file(), {}, { transport: transport(), onProgress: (each) => progress.push(each) });

    const uploading = progress.filter((each) => each.phase === 'uploading');
    expect(uploading[0]).toEqual({ phase: 'uploading', loaded: 0, total: 10 });
    expect(uploading.at(-1)).toEqual({ phase: 'uploading', loaded: 10, total: 10 });
    const loaded = uploading.map((each) => each.loaded);
    expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
    // Half a part on its way counts too.
    expect(loaded).toContain(2);
    expect(progress.slice(uploading.length)).toEqual([
      { phase: 'processing', status: 'queued' },
      { phase: 'processing', status: 'processing', stage: 'assets', done: 1, total: 2 },
    ]);
  });

  it('says the upload again only when its whole percent moves', async () => {
    const { api, transport } = setup();
    const progress: ImportProgress[] = [];
    // 250 parts of four bytes, each reported half-sent and sent.
    await importFile('plot', file('x'.repeat(1000)), {}, { transport: transport(), onProgress: (each) => progress.push(each) });
    expect(api.puts).toHaveLength(250);
    const percents = progress.flatMap((each) => (each.phase === 'uploading' ? [Math.floor((each.loaded / each.total) * 100)] : []));
    expect(percents).toEqual(Array.from({ length: 101 }, (_, at) => at));
  });

  it('sends a part again after a dropped connection, waiting a little first', async () => {
    const { api, transport, sleep } = setup();
    let dropped = false;
    const put: PartPut = async (url, body, options) => {
      if (url.endsWith('/parts/2') && !dropped) {
        dropped = true;
        throw new TypeError('Failed to fetch');
      }
      return api.put(url, body, options);
    };
    await expect(importFile('plot', file(), {}, { transport: transport(put) })).resolves.toEqual(made);
    expect(api.puts.map((each) => each.part).sort()).toEqual([1, 2, 3]);
    expect(sleep).toHaveBeenCalledWith(500, expect.anything());
  });

  it('gives a part up after its tries, says the upload failed, and deletes the upload', async () => {
    const { api, transport, routes, sleep } = setup();
    const tries: string[] = [];
    const put: PartPut = async (url, body, options) => {
      if (url.endsWith('/parts/2')) {
        tries.push(url);
        throw new TypeError('Failed to fetch');
      }
      return api.put(url, body, options);
    };
    const failure = await importFile('plot', file(), {}, { transport: transport(put) }).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).not.toBeInstanceOf(FileImportError);
    expect(failure).toMatchObject({ status: 0, code: 'upload_failed' });
    expect(tries).toHaveLength(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 2000]);
    expect(routes()).toContain('DELETE /api/file-imports/import-1');
    expect(routes()).not.toContain('POST /api/file-imports/import-1/complete');
    expect(api.imports.get('import-1')!.status).toBe('abandoned');
  });

  it('asks again for a store address whose hour is up', async () => {
    const { api, transport } = setup({ addresses: 'store' });
    const put: PartPut = async (url, body, options) =>
      url === 'https://store.test/import-1/1?v=1' ? 403 : api.put(url, body, options);
    await expect(importFile('plot', file(), {}, { transport: transport(put) })).resolves.toEqual(made);
    expect(api.puts.find((each) => each.part === 1)!.url).toBe('https://store.test/import-1/1?v=2');
    const asked = api.fetch.mock.calls.filter(([input]) => String(input).endsWith('/parts'));
    expect(asked.map(([, init]) => JSON.parse(String(init!.body)))).toEqual([{ numbers: [1, 2, 3] }, { numbers: [1] }]);
  });

  it('sends what the store lost when the complete says a part is missing, and only that', async () => {
    const { api, transport, routes } = setup();
    let lost = false;
    // The store answered, and kept nothing.
    const put: PartPut = async (url, body, options) => {
      if (url.endsWith('/parts/3') && !lost) {
        lost = true;
        return 204;
      }
      return api.put(url, body, options);
    };
    await expect(importFile('plot', file(), {}, { transport: transport(put) })).resolves.toEqual(made);
    expect(routes()).toEqual([
      'POST /api/file-imports',
      'POST /api/file-imports/import-1/parts',
      'POST /api/file-imports/import-1/complete',
      'POST /api/file-imports/import-1/parts',
      'POST /api/file-imports/import-1/complete',
      'GET /api/file-imports/import-1',
    ]);
    expect(api.puts.map((each) => each.part).sort()).toEqual([1, 2, 3]);
  });

  it('throws a failed import as an ApiError with the code the old route answered, leaving the server to drop it', async () => {
    const { transport, routes } = setup({
      job: () => ({ error: { status: 400, code: 'invalid_card', message: 'Unsupported card file' } }),
    });
    const failure = await importFile('plot', file(), {}, { transport: transport() }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(FileImportError);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 400, code: 'invalid_card', message: 'Unsupported card file', importId: 'import-1' });
    expect(routes().filter((route) => route.startsWith('DELETE'))).toEqual([]);
  });

  it('keeps asking through a poll that did not get through', async () => {
    const { api, transport } = setup();
    let dropped = false;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && !dropped) {
        dropped = true;
        throw new TypeError('Failed to fetch');
      }
      return api.fetch(input, init);
    }) as typeof globalThis.fetch;
    await expect(importFile('plot', file(), {}, { transport: { ...transport(), fetch } })).resolves.toEqual(made);
  });

  it('confirms a module’s low-level access on the import that asked, without sending the file again', async () => {
    const read: string[] = [];
    const { api, transport, routes } = setup({
      job: ({ body, text }) => {
        read.push(text);
        return body['confirmLowLevelAccess'] === true
          ? { result: { id: 'rm-1', importWarnings: [] } }
          : { error: { status: 409, code: 'low_level_access_unconfirmed', message: 'confirm' } };
      },
    });
    const asked = await importFile('reader_module', file(), {}, { transport: transport() }).catch((caught: unknown) => caught);
    expect(asked).toBeInstanceOf(FileImportError);
    expect(asked).toMatchObject({ code: 'low_level_access_unconfirmed', importId: 'import-1' });
    const sent = api.put.mock.calls.length;

    const progress: ImportProgress[] = [];
    const result = await confirmImport((asked as FileImportError).importId, {
      transport: transport(),
      onProgress: (each) => progress.push(each),
    });
    expect(result).toEqual({ id: 'rm-1', importWarnings: [] });
    expect(api.put.mock.calls).toHaveLength(sent);
    expect(routes().filter((route) => route === 'POST /api/file-imports')).toHaveLength(1);
    expect(routes()).toContain('POST /api/file-imports/import-1/confirm');
    expect(routes().filter((route) => route.startsWith('DELETE'))).toEqual([]);
    // The second reading is of the file the server kept.
    expect(read).toEqual(['abcdefghij', 'abcdefghij']);
    expect(progress[0]).toEqual({ phase: 'processing', status: 'queued' });
  });

  it('gives the upload up on the server when the reader aborts it', async () => {
    const { api, transport, routes } = setup();
    const controller = new AbortController();
    const put: PartPut = async (url, body, options) => {
      if (url.endsWith('/parts/2')) controller.abort();
      return api.put(url, body, options);
    };
    await expect(
      importFile('plot', file(), {}, { transport: transport(put), signal: controller.signal }),
    ).rejects.toThrow();
    expect(routes()).toContain('DELETE /api/file-imports/import-1');
    expect(routes()).not.toContain('POST /api/file-imports/import-1/complete');
    expect(api.imports.get('import-1')!.status).toBe('abandoned');
  });

  it('gives the upload up on the server when the tab closes while the parts go up, and not after', async () => {
    const { api, transport, routes } = setup();
    const page = new EventTarget();
    vi.stubGlobal('window', page);
    let closed = false;
    const put: PartPut = async (url, body, options) => {
      if (url.endsWith('/parts/2') && !closed) {
        closed = true;
        page.dispatchEvent(new Event('pagehide'));
      }
      return api.put(url, body, options);
    };
    await importFile('plot', file(), {}, { transport: transport(put) }).catch(() => undefined);
    // The first, on the way out, outlives the page; the parts after it find the import given up.
    const deletes = api.fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect([String(deletes[0]![0]), deletes[0]![1]?.keepalive]).toEqual(['/api/file-imports/import-1', true]);
    expect(api.imports.get('import-1')!.status).toBe('abandoned');
    expect(routes()).not.toContain('POST /api/file-imports/import-1/complete');

    // Once the file is up, closing the tab leaves the import to the server.
    const second = setup();
    vi.stubGlobal('window', page);
    await importFile('plot', file(), {}, { transport: second.transport() });
    page.dispatchEvent(new Event('pagehide'));
    expect(second.routes().filter((route) => route.startsWith('DELETE'))).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('throws the start’s own refusal, sending nothing', async () => {
    const { api, transport } = setup();
    const failure = await importFile('plot', file(''), {}, { transport: transport() }).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ status: 400, code: 'invalid_card' });
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe('xhrPut', () => {
  /** XMLHttpRequest as much as `xhrPut` reaches for, settled by the test. */
  class FakeXhr {
    static last: FakeXhr;
    method = '';
    url = '';
    body: unknown;
    headers: string[] = [];
    status = 0;
    aborted = false;
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() {
      FakeXhr.last = this;
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string) {
      this.headers.push(name);
    }
    send(body: unknown) {
      this.body = body;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }

  afterEach(() => vi.unstubAllGlobals());

  it('PUTs the part with no headers, reports bytes as they go and answers the status', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const loaded: number[] = [];
    const part = new Blob(['abcd']);
    const done = xhrPut('https://store.test/x/1', part, { onProgress: (bytes) => loaded.push(bytes) });
    const xhr = FakeXhr.last;
    expect([xhr.method, xhr.url, xhr.body, xhr.headers]).toEqual(['PUT', 'https://store.test/x/1', part, []]);
    xhr.upload.onprogress!({ loaded: 2 });
    xhr.upload.onprogress!({ loaded: 4 });
    xhr.status = 200;
    xhr.onload!();
    await expect(done).resolves.toBe(200);
    expect(loaded).toEqual([2, 4]);
  });

  it('rejects on a dropped connection and stops on an abort', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const dropped = xhrPut('/api/file-imports/x/parts/1', new Blob(['a']), { onProgress: () => undefined });
    FakeXhr.last.onerror!();
    await expect(dropped).rejects.toBeInstanceOf(TypeError);

    const controller = new AbortController();
    const stopped = xhrPut('/api/file-imports/x/parts/1', new Blob(['a']), {
      onProgress: () => undefined,
      signal: controller.signal,
    });
    controller.abort();
    await expect(stopped).rejects.toThrow();
    expect(FakeXhr.last.aborted).toBe(true);
  });
});

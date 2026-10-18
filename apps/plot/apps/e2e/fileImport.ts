import { expect, type APIRequestContext } from '@playwright/test';

/** What a file is imported as, and what rode beside it (`POST /api/file-imports`). */
export interface FileImportRequest {
  target: 'plot' | 'member' | 'plot_module' | 'reader_module';
  plotId?: string;
  sourceUrl?: string;
  confirmLowLevelAccess?: boolean;
  worldInfo?: string;
}

/**
 * Imports a card or module file as the web app does, for a spec that sets one
 * up without the forms (ARCHITECTURE §10 파일 임포트): the import started, the
 * file sent in parts where the API says — to itself under the local driver —
 * and the import polled until it ends. Answers the
 * finished import's status and body: 201 and what the import made, or the
 * failure's status and `{ code }`.
 */
export async function importFile(
  request: APIRequestContext,
  base: string,
  headers: Record<string, string>,
  body: FileImportRequest,
  file: { name: string; buffer: Buffer },
): Promise<{ status: number; json: any }> {
  const started = await request.post(`${base}/api/file-imports`, {
    headers,
    data: { ...body, fileName: file.name, size: file.buffer.length },
  });
  if (started.status() !== 201) return { status: started.status(), json: await started.json() };
  const { id, partSize, parts } = (await started.json()) as { id: string; partSize: number; parts: number };
  const numbers = Array.from({ length: parts }, (_, i) => i + 1);
  const asked = await request.post(`${base}/api/file-imports/${id}/parts`, { headers, data: { numbers } });
  expect(asked.status(), await asked.text()).toBe(200);
  const { urls } = (await asked.json()) as { urls: Record<string, string> };
  for (const n of numbers) {
    const url = urls[n]!;
    const sent = await request.put(url.startsWith('/') ? `${base}${url}` : url, {
      headers: url.startsWith('/') ? headers : {},
      data: file.buffer.subarray((n - 1) * partSize, n * partSize),
    });
    expect(sent.ok(), `part ${n}: ${sent.status()}`).toBe(true);
  }
  const completed = await request.post(`${base}/api/file-imports/${id}/complete`, { headers, data: {} });
  expect(completed.status(), await completed.text()).toBe(202);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await (await request.get(`${base}/api/file-imports/${id}`, { headers })).json();
    if (status.status === 'done') return { status: 201, json: status.result };
    if (status.status === 'failed') return { status: status.error.status, json: { code: status.error.code } };
    expect(Date.now(), `import ${id} still ${status.status}`).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Card and module files a reader imports (ARCHITECTURE §10 파일 임포트): a card
 * as a new plot, a card as one more member of a plot, a RisuAI module into a
 * work or into the reader's library.
 *
 * The file never passes through the web or this API's body. The reader's
 * browser asks for an import (`POST /api/file-imports`), uploads the file in
 * parts straight into the store — to presigned addresses on S3, or to this API
 * under the local driver, which writes each part to disk as it streams — and
 * says it is done (`…/complete`). That queues a job (`file_import`, `jobs.ts`)
 * that reads the file back by ranges: a streaming SHA-256 for its record, the
 * card or module parsed from what it is made of (`readCardSource`,
 * `readRisuModuleSource`), each picture streamed into the store on its own. The
 * page polls `GET /api/file-imports/:id` for where it is and, at the end, the
 * same answer the import gave when it was one request.
 *
 * So an import's memory is a few parts and what a card is made of
 * (`MAX_READ_WHOLE_BYTES`), whatever the file's size, and they are read one at
 * a time, on a job loop of their own (`index.ts`).
 *
 * Nothing an import leaves is kept: the uploaded file goes when the job is done
 * with it; what a failed import wrote is taken back (`FileImportWritten`); an
 * upload nobody finished is abandoned and dropped by the sweep the next import
 * runs (`sweepFileImports`).
 */
import {
  ByteSourceError,
  collectBytes,
  MAX_CARD_IMPORT_BYTES,
  MAX_CHARACTERS_PER_PLOT,
  ModuleParseError,
  readCardSource,
  readRisuModuleSource,
  type ByteSource,
  type LoreEntry,
  type ParsedCardSource,
  type ParsedRisuModule,
} from '@shizue/core';
import {
  characters,
  fileImportKeys,
  fileImports,
  jobs,
  plots,
  readerModules,
  type FileImport,
  type FileImportError,
  type FileImportResult,
  type FileImportTarget,
  type FileImportWritten,
} from '@shizue/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import type { AppDeps, AppEnv } from './deps.js';
import { ApiError, badRequest, notFound } from './errors.js';
import { enqueueJob } from './jobs.js';
import { loadOwnedPlot } from './plots.js';
import {
  coerceSourceUrl,
  importCardAsMember,
  importCardAsPlot,
  importPlotModule,
  importProvenance,
  MAX_IMPORT_FILE_NAME_LENGTH,
  ownerView,
  readWorldInfo,
  toMemberJson,
  undoImportWrites,
  type CardUpload,
} from './routes/plots.js';
import { importReaderModule, toReaderModuleJson } from './routes/readerModules.js';
import { deleteQuietly, importFileKey, PartSizeMismatch, readAll, type UploadedPart } from './storage.js';
import { isUuid, readJsonBody, requireString, requireUuidParam } from './util.js';

/**
 * The parts a file is uploaded in, over S3's 5MB floor for every part but the
 * last, as when parts went to a bucket. A 1GB card is 128 of them.
 */
export const FILE_IMPORT_PART_BYTES = 8 * 1024 * 1024;
/** S3's most parts an upload may have, which a file past 80GB would need a larger part for. */
const MAX_PARTS = 10_000;
/**
 * A World Info file beside a card, which rides in the request that starts the
 * import (`worldInfo`) to be read before the card is uploaded — so a file the
 * import cannot read is refused while the card is still on the reader's machine.
 * The owner set it on 2026-10-17.
 */
export const MAX_WORLD_INFO_BYTES = 32 * 1024 * 1024;
/** Part addresses asked for at once: a few parts' worth of time ahead of the upload, inside their hour. */
const MAX_PARTS_PER_ASK = 32;
/**
 * A reader's own upload untouched this long — no part asked for, none sent to
 * this API — is given up when they start another: their import is one at a
 * time, and a closed tab must not hold it.
 */
const STALE_UPLOAD_MS = 15 * 60_000;
/** An upload not finished in a day is abandoned whoever asks. */
const UPLOAD_TTL_MS = 24 * 60 * 60_000;
/** A failed import keeps its file this long for the reader's yes to a module's low-level access. */
const CONFIRM_TTL_MS = 60 * 60_000;
/** A queued or running import whose job is gone and that nothing has touched this long has lost its worker. */
const STALLED_MS = 30 * 60_000;
/** Finished imports are answered this long, for a page that comes back to ask. */
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60_000;
/** Rows one sweep takes on, so the request that runs it stays quick. */
const SWEEP_BATCH = 20;
/** How often a running import writes where it is, for the page that polls it. */
const PROGRESS_MS = 1_000;

const TARGETS: readonly FileImportTarget[] = ['plot', 'member', 'plot_module', 'reader_module'];

/** Where a running import is, for the page: reading the file, storing its pictures, fetching what it loads from other hosts. */
export type ImportStage = 'reading' | 'assets' | 'localizing';

/**
 * What an import's writes tell the job as they go (`importCardAsPlot` and the
 * rest). `wrote` is called before a row or an object is written, so a failure —
 * or a worker that dies — can take back everything the import made; `progress`
 * says where it is.
 */
export interface ImportHooks {
  wrote(written: FileImportWritten & { keys?: string[] }): Promise<void>;
  progress(stage: ImportStage, done?: number, total?: number): void;
}

const isModule = (target: FileImportTarget): boolean => target === 'plot_module' || target === 'reader_module';
const partsOf = (row: Pick<FileImport, 'size' | 'partSize'>): number => Math.max(1, Math.ceil(row.size / row.partSize));
/** The size part `part` must be: the part size, but for the last, which is what is left. */
const sizeOfPart = (row: Pick<FileImport, 'size' | 'partSize'>, part: number): number =>
  part < partsOf(row) ? row.partSize : row.size - (partsOf(row) - 1) * row.partSize;
const fileKey = (row: Pick<FileImport, 'id'>): string => importFileKey(row.id, 'file');

const importState = (row: Pick<FileImport, 'status'>): ApiError =>
  new ApiError(409, 'import_state', `The import is ${row.status}`);

async function loadOwnedImport(deps: AppDeps, id: string, userId: string): Promise<FileImport> {
  const [row] = await deps.db
    .select()
    .from(fileImports)
    .where(and(eq(fileImports.id, id), eq(fileImports.userId, userId)))
    .limit(1);
  if (!row) throw notFound('Import not found');
  return row;
}

const touch = (deps: AppDeps, id: string): Promise<unknown> =>
  deps.db.update(fileImports).set({ updatedAt: new Date() }).where(eq(fileImports.id, id));

/** Drops what an import uploaded: the open upload and its parts, the joined file, the World Info beside it. */
async function dropStaged(deps: AppDeps, row: Pick<FileImport, 'id' | 'uploadId'>): Promise<void> {
  if (row.uploadId) await deps.storage.uploads.abort(fileKey(row), row.uploadId).catch(() => undefined);
  await deleteQuietly(deps.storage, fileKey(row));
  await deleteQuietly(deps.storage, importFileKey(row.id, 'world-info'));
  await deps.db.update(fileImports).set({ staged: false, uploadId: null }).where(eq(fileImports.id, row.id));
}

/**
 * The uploaded file as the parsers read it: ranged reads from the store, every
 * failure of the store a `ByteSourceError` — never taken for a file that is not
 * a card. A read of the whole file from its start hashes it as it goes, which
 * is the provenance's SHA-256 of the bytes as uploaded (`sha256`); a parse that
 * reads front to back (a PNG card, a `.risum`) pays for it once.
 */
function storageSource(
  deps: AppDeps,
  row: Pick<FileImport, 'id' | 'size'>,
  onHashed: (bytes: number) => void,
): ByteSource & { sha256(): Promise<string> } {
  const key = fileKey(row);
  const size = row.size;
  let digest: string | undefined;
  async function* stream(offset: number, length: number): AsyncGenerator<Uint8Array> {
    if (length <= 0) return;
    let object;
    try {
      object = await deps.storage.get(key, { start: offset, end: offset + length - 1 });
    } catch (error) {
      throw new ByteSourceError('The uploaded file could not be read', { cause: error });
    }
    if (!object) throw new ByteSourceError('The uploaded file is gone');
    const hash = offset === 0 && length === size && digest === undefined ? createHash('sha256') : undefined;
    let seen = 0;
    try {
      for await (const chunk of object.body) {
        if (hash) {
          hash.update(chunk);
          onHashed(seen + chunk.length);
        }
        seen += chunk.length;
        yield chunk;
      }
    } catch (error) {
      throw new ByteSourceError('The store stopped sending the uploaded file', { cause: error });
    }
    if (hash && seen === size) digest = hash.digest('hex');
  }
  return {
    size,
    stream,
    read: (offset, length) =>
      collectBytes(stream(offset, length), length, () => new ByteSourceError('The store sent more than was asked')),
    async sha256() {
      if (digest === undefined) for await (const _chunk of stream(0, size));
      if (digest === undefined) throw new ByteSourceError('The uploaded file is not the size it was said to be');
      return digest;
    },
  };
}

/**
 * The hooks a running import reports through: what it wrote, appended to the
 * row before it writes it, and where it is, written at most once a second.
 */
function trackerFor(deps: AppDeps, id: string): ImportHooks & { flush(): Promise<void> } {
  let pending: { stage: ImportStage; progress: { done: number; total: number } | null } | undefined;
  let last = 0;
  /** Whether `written` is set yet: from the first write on, a dead attempt is one that died writing. */
  let recorded = false;
  let writing: Promise<unknown> = Promise.resolve();
  const write = (): void => {
    const next = pending!;
    pending = undefined;
    last = Date.now();
    writing = writing
      .then(() =>
        deps.db
          .update(fileImports)
          .set({ stage: next.stage, progress: next.progress, updatedAt: new Date() })
          .where(eq(fileImports.id, id)),
      )
      .catch((error: unknown) => console.warn(`[file-import] ${id}: progress not written`, error));
  };
  return {
    async wrote({ keys = [], ...ids }) {
      if (!recorded || Object.keys(ids).length > 0) {
        recorded = true;
        await deps.db
          .update(fileImports)
          .set({ written: sql`coalesce(${fileImports.written}, '{}'::jsonb) || ${JSON.stringify(ids)}::jsonb` })
          .where(eq(fileImports.id, id));
      }
      if (keys.length > 0) {
        await deps.db
          .insert(fileImportKeys)
          .values(keys.map((key) => ({ importId: id, key })))
          .onConflictDoNothing();
      }
    },
    progress(stage, done, total) {
      pending = { stage, progress: done === undefined || total === undefined ? null : { done, total } };
      if (Date.now() - last >= PROGRESS_MS) write();
    },
    async flush() {
      if (pending) write();
      await writing;
    },
  };
}

/** The plot a member or module import goes into — gone if it was deleted while the file was uploading. */
function plotOf(row: FileImport): string {
  if (!row.plotId) throw notFound('Plot not found');
  return row.plotId;
}

/** Reads the uploaded file and writes what it is, as the import routes did when the file came in their body. */
async function importFile(deps: AppDeps, row: FileImport, hooks: ImportHooks): Promise<FileImportResult> {
  const source = storageSource(deps, row, (done) => hooks.progress('reading', done, row.size));
  hooks.progress('reading', 0, row.size);
  if (isModule(row.target)) {
    let parsed: ParsedRisuModule;
    try {
      parsed = await readRisuModuleSource(source);
    } catch (error) {
      if (error instanceof ModuleParseError) throw badRequest('invalid_module', error.message);
      throw error;
    }
    const upload = { parsed, fileName: row.fileName, sha256: await source.sha256() };
    return row.target === 'plot_module'
      ? importPlotModule(deps, row.userId, plotOf(row), upload, hooks)
      : importReaderModule(deps, row.userId, { ...upload, confirmLowLevelAccess: row.options.confirmLowLevelAccess === true }, hooks);
  }

  let parsed: ParsedCardSource;
  try {
    parsed = await readCardSource(source);
  } catch (error) {
    // Card files are user-controlled bytes, so every parse failure is a 400, never a 500.
    if (error instanceof ByteSourceError) throw error;
    throw badRequest('invalid_card', error instanceof Error ? error.message : 'Unreadable character card');
  }
  const sha256 = await source.sha256();
  let lorebook: LoreEntry[] | undefined;
  if (row.options.worldInfo) {
    const object = await deps.storage.get(importFileKey(row.id, 'world-info'));
    if (!object) throw new ByteSourceError('The World Info file is gone');
    lorebook = readWorldInfo(new TextDecoder().decode(await readAll(object.body)));
  }
  const upload: CardUpload = {
    parsed: lorebook ? { ...parsed, card: { ...parsed.card, lorebook } } : parsed,
    fileName: row.fileName,
    imported: { importedFrom: importProvenance(row.fileName, sha256, row.options.sourceUrl) },
  };
  return row.target === 'plot'
    ? importCardAsPlot(deps, row.userId, upload, hooks)
    : importCardAsMember(deps, row.userId, plotOf(row), upload, hooks);
}

/** What a failure is told as: the API's own errors as they are, anything else an internal error, logged. */
function failureOf(id: string, error: unknown): FileImportError {
  if (error instanceof ApiError) return { status: error.status, code: error.code, message: error.message };
  console.error(`[file-import] ${id} failed`, error);
  return { status: 500, code: 'internal_error', message: 'The import could not be finished' };
}

/** Takes back what an import wrote, read fresh: the job may have written more than the row it was handed said. */
async function undoWrites(deps: AppDeps, row: FileImport): Promise<void> {
  const [fresh] = await deps.db
    .select({ written: fileImports.written })
    .from(fileImports)
    .where(eq(fileImports.id, row.id))
    .limit(1);
  const written = fresh?.written;
  if (!written) return;
  const keys = (
    await deps.db.select({ key: fileImportKeys.key }).from(fileImportKeys).where(eq(fileImportKeys.importId, row.id))
  ).map(({ key }) => key);
  if (row.target === 'reader_module') {
    if (written.readerModuleId) {
      await deps.db.delete(readerModules).where(eq(readerModules.id, written.readerModuleId));
    }
    for (const key of keys) await deleteQuietly(deps.storage, key);
  } else {
    await undoImportWrites(deps, written, keys, row.target, row.plotId);
  }
  await deps.db.delete(fileImportKeys).where(eq(fileImportKeys.importId, row.id));
}

/** Ends an import as failed: its writes taken back, its file dropped — but for one that waits on the reader. */
async function failImport(deps: AppDeps, row: FileImport, failure: FileImportError): Promise<void> {
  await undoWrites(deps, row);
  await deps.db
    .update(fileImports)
    .set({ status: 'failed', error: failure, stage: null, progress: null, written: null, updatedAt: new Date() })
    .where(eq(fileImports.id, row.id));
  // A module waiting on the reader's yes keeps its file, so the yes needs no second upload.
  if (failure.code !== 'low_level_access_unconfirmed') await dropStaged(deps, row);
}

/**
 * The `file_import` job. Never throws for what the file or the import does —
 * those end the import as failed, with the code the old routes answered. A
 * worker that dies leaves the job to be claimed again (`jobs.ts`): an attempt
 * that finds the import already writing takes those writes back and fails it,
 * since half an import is not something to finish; one that died while still
 * reading starts over.
 */
export async function runFileImport(deps: AppDeps, importId: string): Promise<void> {
  const [row] = await deps.db.select().from(fileImports).where(eq(fileImports.id, importId)).limit(1);
  if (!row || (row.status !== 'queued' && row.status !== 'processing')) return;
  if (row.written) {
    await failImport(deps, row, failureOf(row.id, new Error('The worker running the import stopped')));
    return;
  }
  await deps.db
    .update(fileImports)
    .set({ status: 'processing', stage: 'reading', progress: null, error: null, updatedAt: new Date() })
    .where(eq(fileImports.id, row.id));
  const tracker = trackerFor(deps, row.id);
  let result: FileImportResult;
  try {
    result = await importFile(deps, row, tracker);
  } catch (error) {
    await tracker.flush();
    await failImport(deps, row, failureOf(row.id, error));
    return;
  }
  await tracker.flush();
  await deps.db
    .update(fileImports)
    .set({ status: 'done', result, stage: null, progress: null, written: null, updatedAt: new Date() })
    .where(eq(fileImports.id, row.id));
  // What it stored is named by the rows it made now.
  await deps.db.delete(fileImportKeys).where(eq(fileImportKeys.importId, row.id));
  await dropStaged(deps, row);
}

/** Whether an import's job is still waiting or running: a queued import behind a long one is not stalled. */
async function jobPending(deps: AppDeps, importId: string): Promise<boolean> {
  const [job] = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, 'file_import'), eq(jobs.status, 'pending'), sql`${jobs.payload}->>'importId' = ${importId}`))
    .limit(1);
  return Boolean(job);
}

/**
 * Collects what imports left behind, a batch at a time — run by each import
 * that starts; there is no loop of its own. Uploads not finished in a day are
 * abandoned, and their parts and files dropped; imports whose worker died with
 * no job left to finish them are failed and their writes taken back; a module
 * the reader never said yes to gives up its file after an hour; and finished
 * imports are forgotten after a week.
 */
export async function sweepFileImports(deps: AppDeps): Promise<void> {
  const now = Date.now();
  const expired = await deps.db
    .update(fileImports)
    .set({ status: 'abandoned', updatedAt: new Date() })
    .where(
      inArray(
        fileImports.id,
        deps.db
          .select({ id: fileImports.id })
          .from(fileImports)
          .where(and(eq(fileImports.status, 'uploading'), lt(fileImports.createdAt, new Date(now - UPLOAD_TTL_MS))))
          .limit(SWEEP_BATCH),
      ),
    )
    .returning();
  for (const row of expired) await dropStaged(deps, row);

  const quiet = await deps.db
    .select()
    .from(fileImports)
    .where(and(inArray(fileImports.status, ['queued', 'processing']), lt(fileImports.updatedAt, new Date(now - STALLED_MS))))
    .limit(SWEEP_BATCH);
  for (const row of quiet) {
    if (await jobPending(deps, row.id)) continue;
    await failImport(deps, row, failureOf(row.id, new Error('The import stopped with no worker to finish it')));
  }

  const waiting = await deps.db
    .select()
    .from(fileImports)
    .where(and(eq(fileImports.status, 'failed'), eq(fileImports.staged, true), lt(fileImports.updatedAt, new Date(now - CONFIRM_TTL_MS))))
    .limit(SWEEP_BATCH);
  for (const row of waiting) await dropStaged(deps, row);

  await deps.db
    .delete(fileImports)
    .where(
      inArray(
        fileImports.id,
        deps.db
          .select({ id: fileImports.id })
          .from(fileImports)
          .where(
            and(
              inArray(fileImports.status, ['done', 'failed', 'abandoned']),
              eq(fileImports.staged, false),
              lt(fileImports.updatedAt, new Date(now - KEEP_FINISHED_MS)),
            ),
          )
          .limit(SWEEP_BATCH * 5),
      ),
    );
}

/** The answer a finished import gives: the one its route gave when it was a single request. */
async function resultBody(deps: AppDeps, row: FileImport): Promise<unknown> {
  const result = row.result!;
  const importWarnings = result.importWarnings;
  if (row.target === 'reader_module') {
    const [module] = await deps.db
      .select()
      .from(readerModules)
      .where(and(eq(readerModules.id, result.readerModuleId ?? ''), eq(readerModules.userId, row.userId)))
      .limit(1);
    return module ? { ...toReaderModuleJson(module), importWarnings } : null;
  }
  const [plot] = await deps.db
    .select()
    .from(plots)
    .where(and(eq(plots.id, result.plotId ?? ''), eq(plots.ownerId, row.userId)))
    .limit(1);
  if (!plot) return null;
  if (row.target === 'member') {
    const [member] = await deps.db
      .select()
      .from(characters)
      .where(and(eq(characters.id, result.characterId ?? ''), eq(characters.plotId, plot.id)))
      .limit(1);
    if (!member) return null;
    return { ...toMemberJson(plot, member), variableConflicts: result.variableConflicts ?? [], importWarnings };
  }
  return { ...((await ownerView(deps, plot)) as object), importWarnings };
}

/** What the page polls: where the import is, and its answer once it has one. */
async function statusOf(deps: AppDeps, row: FileImport): Promise<Record<string, unknown>> {
  return {
    id: row.id,
    target: row.target,
    status: row.status,
    fileName: row.fileName,
    size: row.size,
    partSize: row.partSize,
    parts: partsOf(row),
    ...(row.stage ? { stage: row.stage } : {}),
    ...(row.progress ? { progress: row.progress } : {}),
    ...(row.status === 'failed' && row.error ? { error: row.error } : {}),
    ...(row.status === 'done' && row.result ? { result: await resultBody(deps, row) } : {}),
  };
}

/** The part size for a file: 8MB, or what keeps a very large one within S3's count of parts. */
const partSizeFor = (size: number): number => Math.max(FILE_IMPORT_PART_BYTES, Math.ceil(size / MAX_PARTS));

/**
 * `POST /api/file-imports` and what hangs off it (behind `ownerGate`, app.ts).
 * The refusals an import's own route gave before it read the file are given
 * here, before the file is uploaded; the ones that need the file come back
 * through `GET …/:id` as a failed import with the same code.
 */
export function fileImportRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const target = body['target'] as FileImportTarget;
    if (!TARGETS.includes(target)) throw badRequest('invalid_request', `target must be one of ${TARGETS.join(', ')}`);
    const fileName = requireString(body, 'fileName').slice(0, MAX_IMPORT_FILE_NAME_LENGTH);
    const size = body['size'];
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw badRequest('invalid_request', 'size must be the file size in bytes');
    }
    const module = isModule(target);
    if (size > MAX_CARD_IMPORT_BYTES) {
      throw new ApiError(413, 'payload_too_large', `A ${module ? 'module' : 'card'} file is at most ${MAX_CARD_IMPORT_BYTES} bytes`);
    }
    if (size === 0) {
      throw module
        ? badRequest('invalid_module', 'Not a RisuAI module: neither a charx, a .risum file nor JSON')
        : badRequest('invalid_card', 'Unsupported card file: not PNG, charx, or JSON');
    }
    const confirmLowLevelAccess = body['confirmLowLevelAccess'] === true;

    let sourceUrl: string | undefined;
    let worldInfo: string | undefined;
    if (!module) {
      sourceUrl = coerceSourceUrl(body['sourceUrl'] ?? null);
      const text = body['worldInfo'];
      if (text !== undefined && text !== null && text !== '') {
        if (typeof text !== 'string') throw badRequest('invalid_request', 'worldInfo must be the file as text');
        if (Buffer.byteLength(text) > MAX_WORLD_INFO_BYTES) {
          throw new ApiError(413, 'payload_too_large', `A World Info file is at most ${MAX_WORLD_INFO_BYTES} bytes`);
        }
        // Read now, so an unreadable one is refused while the card is still on the reader's machine.
        readWorldInfo(text);
        worldInfo = text;
      }
    }
    let plotId: string | null = null;
    if (target === 'member' || target === 'plot_module') {
      const value = body['plotId'];
      if (typeof value !== 'string' || !isUuid(value)) throw notFound('Plot not found');
      const plot = await loadOwnedPlot(deps, value, userId);
      plotId = plot.id;
      if (target === 'member') {
        const [counted] = await deps.db
          .select({ value: sql<number>`count(*)::int` })
          .from(characters)
          .where(eq(characters.plotId, plot.id));
        if ((counted?.value ?? 0) >= MAX_CHARACTERS_PER_PLOT) {
          throw badRequest('character_limit', `A plot holds at most ${MAX_CHARACTERS_PER_PLOT} characters`);
        }
      }
    }
    // The reader's own upload left untouched is given up for this one.
    const superseded = await deps.db
      .update(fileImports)
      .set({ status: 'abandoned', updatedAt: new Date() })
      .where(
        and(
          eq(fileImports.userId, userId),
          eq(fileImports.status, 'uploading'),
          lt(fileImports.updatedAt, new Date(Date.now() - STALE_UPLOAD_MS)),
        ),
      )
      .returning();
    for (const row of superseded) await dropStaged(deps, row);

    const id = randomUUID();
    const partSize = partSizeFor(size);
    await deps.db.insert(fileImports).values({
      id,
      userId,
      target,
      plotId,
      fileName,
      size,
      partSize,
      options: {
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(confirmLowLevelAccess ? { confirmLowLevelAccess } : {}),
        ...(worldInfo ? { worldInfo: true } : {}),
      },
    });
    try {
      const uploadId = await deps.storage.uploads.create(importFileKey(id, 'file'), 'application/octet-stream');
      await deps.db.update(fileImports).set({ uploadId }).where(eq(fileImports.id, id));
      if (worldInfo) await deps.storage.put(importFileKey(id, 'world-info'), Buffer.from(worldInfo), 'application/json');
    } catch (error) {
      const [row] = await deps.db
        .update(fileImports)
        .set({ status: 'failed', error: failureOf(id, error), updatedAt: new Date() })
        .where(eq(fileImports.id, id))
        .returning();
      if (row) await dropStaged(deps, row);
      throw error;
    }
    // A few statements on a quiet table; a sweep that fails costs this import nothing.
    await sweepFileImports(deps).catch((error: unknown) => console.warn('[file-import] sweep failed', error));
    return c.json({ id, status: 'uploading', partSize, parts: partsOf({ size, partSize }) }, 201);
  });

  /**
   * `{ numbers }`: where to send those parts — an address on the store, an hour
   * and the part's size good, or this API's own (`PUT …/parts/:n`) — and which
   * parts are already there, so an upload that broke off sends only the rest.
   */
  app.post('/:id/parts', async (c) => {
    const row = await loadOwnedImport(deps, requireUuidParam(c), c.get('userId'));
    if (row.status !== 'uploading' || !row.uploadId) throw importState(row);
    const body = await readJsonBody(c);
    const numbers = body['numbers'];
    const parts = partsOf(row);
    if (
      !Array.isArray(numbers) ||
      numbers.length > MAX_PARTS_PER_ASK ||
      numbers.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > parts)
    ) {
      throw badRequest('invalid_request', `numbers must be up to ${MAX_PARTS_PER_ASK} part numbers from 1 to ${parts}`);
    }
    await touch(deps, row.id);
    const urls: Record<string, string> = {};
    for (const n of numbers as number[]) {
      urls[n] =
        (await deps.storage.uploads.partUrl(fileKey(row), row.uploadId, n, sizeOfPart(row, n))) ??
        `/api/file-imports/${row.id}/parts/${n}`;
    }
    const uploaded = (await deps.storage.uploads.parts(fileKey(row), row.uploadId))
      .filter(({ part, size }) => part <= parts && size === sizeOfPart(row, part))
      .map(({ part }) => part);
    return c.json({ urls, uploaded });
  });

  /** A part, where the store takes none itself (the local driver): streamed to disk, kept only at its size. */
  app.put('/:id/parts/:part', async (c) => {
    const row = await loadOwnedImport(deps, requireUuidParam(c), c.get('userId'));
    if (row.status !== 'uploading' || !row.uploadId) throw importState(row);
    const part = Number(c.req.param('part'));
    if (!Number.isInteger(part) || part < 1 || part > partsOf(row)) throw notFound('No such part');
    const expected = sizeOfPart(row, part);
    if ((await deps.storage.uploads.partUrl(fileKey(row), row.uploadId, part, expected)) !== null) {
      throw notFound('Parts go to the store');
    }
    const body = c.req.raw.body;
    if (!body) throw badRequest('invalid_request', 'A part needs its bytes');
    try {
      await deps.storage.uploads.write(fileKey(row), row.uploadId, part, body, expected);
    } catch (error) {
      if (error instanceof PartSizeMismatch) throw badRequest('invalid_request', `Part ${part} must be ${expected} bytes`);
      throw error;
    }
    await touch(deps, row.id);
    return c.body(null, 204);
  });

  /**
   * Every part is there: they are joined into the file and the import is
   * queued. A part missing, or not its size, is 409 `upload_incomplete` — the
   * page asks for the parts again and sends what is missing.
   */
  app.post('/:id/complete', async (c) => {
    const row = await loadOwnedImport(deps, requireUuidParam(c), c.get('userId'));
    if (row.status === 'queued' || row.status === 'processing' || row.status === 'done') {
      return c.json({ id: row.id, status: row.status }, 202);
    }
    if (row.status !== 'uploading' || !row.uploadId) throw importState(row);
    const parts = partsOf(row);
    const stored = new Map<number, UploadedPart>();
    for (const part of await deps.storage.uploads.parts(fileKey(row), row.uploadId)) {
      if (part.part <= parts && part.size === sizeOfPart(row, part.part)) stored.set(part.part, part);
    }
    const missing = parts - stored.size;
    if (missing > 0) {
      throw new ApiError(409, 'upload_incomplete', `${missing} of ${parts} parts are missing`, { missing });
    }
    try {
      await deps.storage.uploads.complete(fileKey(row), row.uploadId, [...stored.values()].sort((a, b) => a.part - b.part));
    } catch (error) {
      // A second complete racing this one finds the upload already joined.
      const again = await loadOwnedImport(deps, row.id, c.get('userId'));
      if (again.status !== 'uploading') return c.json({ id: row.id, status: again.status }, 202);
      throw error;
    }
    if ((await deps.storage.size(fileKey(row))) !== row.size) {
      await failImport(deps, row, { status: 400, code: 'invalid_request', message: 'The uploaded file is not the size it was said to be' });
      throw badRequest('invalid_request', 'The uploaded file is not the size it was said to be');
    }
    const queued = await deps.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(fileImports)
        .set({ status: 'queued', uploadId: null, updatedAt: new Date() })
        .where(and(eq(fileImports.id, row.id), eq(fileImports.status, 'uploading')))
        .returning({ id: fileImports.id });
      // Two tries: the second is there only to take back what a dead worker's first wrote.
      if (updated) await enqueueJob(tx, 'file_import', { importId: row.id }, { maxAttempts: 2 });
      return Boolean(updated);
    });
    if (!queued) return c.json({ id: row.id, status: (await loadOwnedImport(deps, row.id, c.get('userId'))).status }, 202);
    return c.json({ id: row.id, status: 'queued' }, 202);
  });

  app.get('/:id', async (c) => {
    const row = await loadOwnedImport(deps, requireUuidParam(c), c.get('userId'));
    return c.json(await statusOf(deps, row));
  });

  /**
   * The reader's yes to a module that asks for low-level access, on the file
   * the import already has: queued again with the yes, no second upload.
   */
  app.post('/:id/confirm', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    if (body['confirmLowLevelAccess'] !== true) throw badRequest('invalid_request', 'confirmLowLevelAccess must be true');
    const queued = await deps.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(fileImports)
        .set({
          status: 'queued',
          error: null,
          options: sql`${fileImports.options} || '{"confirmLowLevelAccess":true}'::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(fileImports.id, id),
            eq(fileImports.userId, userId),
            eq(fileImports.status, 'failed'),
            eq(fileImports.staged, true),
            sql`${fileImports.error}->>'code' = 'low_level_access_unconfirmed'`,
          ),
        )
        .returning({ id: fileImports.id });
      if (updated) await enqueueJob(tx, 'file_import', { importId: id }, { maxAttempts: 2 });
      return Boolean(updated);
    });
    if (!queued) throw importState(await loadOwnedImport(deps, id, userId));
    return c.json({ id, status: 'queued' }, 202);
  });

  /** The reader gives an import up: an upload in flight, or a failed one's file. One being read is let finish. */
  app.delete('/:id', async (c) => {
    const row = await loadOwnedImport(deps, requireUuidParam(c), c.get('userId'));
    if (row.status === 'queued' || row.status === 'processing') throw importState(row);
    if (row.status === 'uploading') {
      const [abandoned] = await deps.db
        .update(fileImports)
        .set({ status: 'abandoned', updatedAt: new Date() })
        .where(and(eq(fileImports.id, row.id), eq(fileImports.status, 'uploading')))
        .returning();
      if (abandoned) await dropStaged(deps, abandoned);
    } else if (row.staged) {
      await dropStaged(deps, row);
    }
    return c.body(null, 204);
  });

  return app;
}


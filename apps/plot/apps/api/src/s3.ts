import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ByteRange, ObjectPart, ObjectStorage, StoredObject } from './storage.js';

/**
 * Everything the S3-compatible driver needs, read from the environment in
 * env.ts. The same shape serves a local S3 stand-in and real S3; what differs is
 * `endpoint`/`forcePathStyle` and where the credentials come from.
 */
export interface S3Config {
  bucket: string;
  region: string;
  /**
   * The service endpoint, for anything that is not AWS — the local
   * stand-in's `http://localhost:19000`, say. Unset means the SDK's own regional endpoint,
   * which is what real S3 wants.
   */
  endpoint?: string;
  /**
   * Static credentials. Both unset hands the decision to the SDK's default
   * provider chain (`AWS_*`, the shared config file, the instance role), which is
   * how a deployment on AWS should be doing it.
   */
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * `bucket/key` in the path instead of `bucket.` in the hostname. A local
   * store needs it — a virtual-hosted bucket would have to resolve as a subdomain of
   * localhost — and AWS does not.
   */
  forcePathStyle: boolean;
}

/**
 * Whether a failed read means "no such object" rather than "the store is
 * unreachable". S3 answers `NoSuchKey` for a GET and the local stand-in agrees, but a HEAD-ish
 * path can surface as a bare 404 with `NotFound`, so the status is checked too.
 */
function isMissing(error: unknown): boolean {
  const { name, $metadata } = (error ?? {}) as { name?: string; $metadata?: { httpStatusCode?: number } };
  return name === 'NoSuchKey' || name === 'NotFound' || $metadata?.httpStatusCode === 404;
}

/** S3's answer to a range no byte of the object is in. */
function isUnsatisfiable(error: unknown): boolean {
  const { name, $metadata } = (error ?? {}) as { name?: string; $metadata?: { httpStatusCode?: number } };
  return name === 'InvalidRange' || $metadata?.httpStatusCode === 416;
}

const rangeHeader = (range: ByteRange): string =>
  'suffix' in range ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end ?? ''}`;

const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;

/** Where the part S3 sent lies, off its `Content-Range`; undefined when it sent the whole. */
function partOf(contentRange: string | undefined): ObjectPart | undefined {
  const match = contentRange ? CONTENT_RANGE_RE.exec(contentRange) : null;
  return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : undefined;
}

/** S3-compatible storage for chat images. */
export function createS3Storage(config: S3Config): ObjectStorage {
  const client = new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.accessKeyId && config.secretAccessKey
      ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
      : {}),
  });
  const Bucket = config.bucket;

  async function get(key: string, range?: ByteRange): Promise<StoredObject | null> {
    let output;
    try {
      output = await client.send(
        new GetObjectCommand({ Bucket, Key: key, ...(range ? { Range: rangeHeader(range) } : {}) }),
      );
    } catch (error) {
      if (isMissing(error)) return null;
      // A range past the end is answered with the whole object, as the local driver answers it.
      if (range && isUnsatisfiable(error)) return get(key);
      throw error;
    }
    if (!output.Body) return null;
    const part = range ? partOf(output.ContentRange) : undefined;
    return {
      body: output.Body.transformToWebStream() as ReadableStream<Uint8Array>,
      size: output.ContentLength ?? 0,
      ...(part ? { part } : {}),
    };
  }

  return {
    async put(key, bytes, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: contentType }),
      );
    },
    get,
    async delete(key) {
      // S3 answers 204 for a key that was never there, which is the contract.
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

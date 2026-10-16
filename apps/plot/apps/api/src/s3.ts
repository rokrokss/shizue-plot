import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { ByteRange, ObjectPart, ObjectStorage, StagedUploads, StoredObject, UploadedPart } from './storage.js';

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
   * The endpoint a browser reaches the store at, where it is not `endpoint` — a
   * deployment whose API talks to the store over a private address. Only the
   * presigned addresses an import's upload goes to are written with it.
   */
  publicEndpoint?: string;
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

/** A part a presigned address is good for: an hour, a slow connection's longest wait for its turn. */
const PART_URL_SECONDS = 3600;
/**
 * The parts a stream is written in (`putStream`) and how many are sent at once:
 * what an import holds per asset, whatever the asset's size.
 */
const STREAM_PART_BYTES = 8 * 1024 * 1024;
const STREAM_QUEUE = 2;

/** S3-compatible storage for chat images and import files. */
export function createS3Storage(config: S3Config): ObjectStorage {
  const clientConfig = (endpoint: string | undefined): S3ClientConfig => ({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    ...(endpoint ? { endpoint } : {}),
    ...(config.accessKeyId && config.secretAccessKey
      ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
      : {}),
    // The SDK's default signs a CRC32 of the body into every request it can — and
    // into a presigned address that is the checksum of no body at all, so the
    // browser's PUT is refused (400 BadDigest). A checksum only where the
    // operation requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  const client = new S3Client(clientConfig(config.endpoint));
  const signer = config.publicEndpoint ? new S3Client(clientConfig(config.publicEndpoint)) : client;
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

  const uploads: StagedUploads = {
    async create(key, contentType) {
      const output = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }));
      if (!output.UploadId) throw new Error('The store opened no upload');
      return output.UploadId;
    },
    async partUrl(key, uploadId, part, size) {
      // The size is signed in: a part of any other length is refused by the store.
      return getSignedUrl(
        signer,
        new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: part, ContentLength: size }),
        { expiresIn: PART_URL_SECONDS, signableHeaders: new Set(['content-length']) },
      );
    },
    async write() {
      throw new Error('Parts go to the store itself');
    },
    async parts(key, uploadId) {
      const parts: UploadedPart[] = [];
      let marker: string | undefined;
      for (;;) {
        const output = await client.send(
          new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, ...(marker ? { PartNumberMarker: marker } : {}) }),
        );
        for (const part of output.Parts ?? []) {
          if (part.PartNumber === undefined) continue;
          parts.push({ part: part.PartNumber, size: part.Size ?? 0, ...(part.ETag ? { etag: part.ETag } : {}) });
        }
        if (!output.IsTruncated || !output.NextPartNumberMarker) break;
        marker = output.NextPartNumberMarker;
      }
      return parts.sort((a, b) => a.part - b.part);
    },
    async complete(key, uploadId, parts) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map(({ part, etag }) => ({ PartNumber: part, ETag: etag })) },
        }),
      );
    },
    async abort(key, uploadId) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
      } catch (error) {
        if ((error as { name?: string }).name !== 'NoSuchUpload' && !isMissing(error)) throw error;
      }
    },
  };

  return {
    async put(key, bytes, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: contentType }),
      );
    },
    async putStream(key, body, contentType) {
      // A small stream goes as one PUT, a large one in parts; a stream that throws
      // aborts the parts it sent, so nothing is left under the key.
      await new Upload({
        client,
        params: { Bucket, Key: key, Body: Readable.from(body), ContentType: contentType },
        partSize: STREAM_PART_BYTES,
        queueSize: STREAM_QUEUE,
      }).done();
    },
    async size(key) {
      try {
        return (await client.send(new HeadObjectCommand({ Bucket, Key: key }))).ContentLength ?? 0;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    get,
    async delete(key) {
      // S3 answers 204 for a key that was never there, which is the contract.
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    uploads,
  };
}

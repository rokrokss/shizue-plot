/**
 * The S3 driver's test target: the S3-compatible store (RustFS) that
 * `docker-compose.yml` already runs (`docker compose up -d s3`, or `docker start shizue-s3`).
 *
 * Not a fixture the suite can create for itself, so the tests that need it skip
 * when nothing answers on the endpoint rather than failing — but they say so in
 * their names, and `connectS3Server` returning null is the only reason they are ever
 * skipped.
 *
 * That skip is right on a laptop with no S3 server and wrong in a job that just
 * started one, and nothing in the connection attempt can tell the two apart: a
 * refused port, a mistyped secret and a bucket policy all arrive here as the same
 * null. So the environment states its own expectation — `TEST_S3_REQUIRED` — and
 * this module turns the skip into a failure that names what it could not reach.
 * Without it, a wrong `TEST_S3_SECRET_ACCESS_KEY` against a live S3 server leaves
 * eight tests skipped and the run green, which is the same shape of problem as a
 * workflow filed where GitHub never looks.
 */
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { createS3Storage, type S3Config } from '../src/s3.js';
import type { ObjectStorage } from '../src/storage.js';

/**
 * Whether the S3 driver is allowed to skip. Biased towards required: anything
 * other than unset, empty, `0` or `false` means the driver must run. The
 * dangerous direction is a signal that is set but read as "optional" — that is
 * precisely the silent green this variable exists to prevent — so an unrecognised
 * value fails loudly rather than quietly permitting the skip.
 */
const S3_REQUIRED = !['', '0', 'false'].includes(
  (process.env['TEST_S3_REQUIRED'] ?? '').trim().toLowerCase(),
);

/** The compose defaults; every one is overridable for a different target. */
export const s3ServerConfig: S3Config = {
  bucket: process.env['TEST_S3_BUCKET'] ?? 'shizue-media-test',
  region: process.env['TEST_S3_REGION'] ?? 'us-east-1',
  endpoint: process.env['TEST_S3_ENDPOINT'] ?? 'http://localhost:19000',
  accessKeyId: process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'shizue',
  secretAccessKey: process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'shizue-secret',
  // A local store cannot be addressed virtual-hosted on localhost, which is the whole
  // reason the switch exists.
  forcePathStyle: true,
};

/**
 * The reason, flattened. A refused connection arrives from the SDK as an
 * `AggregateError` whose own message is empty and whose causes are the per-address
 * failures, so reading only `.message` would report `AggregateError:` and name
 * nothing — which is the failure this whole mechanism exists to avoid, one level
 * further in.
 */
function describe(error: unknown): string {
  const { name, message, errors, cause } = (error ?? {}) as {
    name?: string;
    message?: string;
    errors?: unknown[];
    cause?: unknown;
  };
  if (message) return `${name ?? 'Error'}: ${message}`;
  const inner = errors?.length ? errors : cause !== undefined ? [cause] : [];
  const causes = [...new Set(inner.map(describe))];
  return causes.length ? `${name ?? 'Error'}: ${causes.join('; ')}` : `${name ?? String(error)}`;
}

/**
 * Why the driver could not be opened, in enough detail to fix it. Names the
 * target and the access key id — the secret is deliberately not quoted back, and
 * a wrong one shows up as the SDK's `SignatureDoesNotMatch` anyway.
 */
function unreachable(error: unknown): Error {
  return new Error(
    `TEST_S3_REQUIRED is set, so the S3 driver has to run here, but the S3 server could not be reached: ` +
      `bucket "${s3ServerConfig.bucket}" at ${s3ServerConfig.endpoint} ` +
      `(region ${s3ServerConfig.region}, access key id "${s3ServerConfig.accessKeyId}") — ` +
      `${describe(error)}. ` +
      `Eight tests across storage.test.ts and api.test.ts would otherwise have skipped and left ` +
      `this run green. Fix the TEST_S3_* values or the container; unset TEST_S3_REQUIRED only ` +
      `where skipping is genuinely right, which is a machine with no S3 server on it.`,
  );
}

/**
 * Creates the bucket if it is not there and returns a driver on it, or null when
 * the endpoint does not answer. One attempt, so an absent S3 server costs a
 * connection refusal rather than the SDK's retry schedule.
 *
 * Throws instead of returning null when `TEST_S3_REQUIRED` says this environment
 * promised an S3 server. Both call sites resolve this at module load, so the throw
 * fails collection of the file rather than reporting a skip.
 */
export async function connectS3Server(): Promise<ObjectStorage | null> {
  const client = new S3Client({
    region: s3ServerConfig.region,
    endpoint: s3ServerConfig.endpoint!,
    forcePathStyle: true,
    credentials: {
      accessKeyId: s3ServerConfig.accessKeyId!,
      secretAccessKey: s3ServerConfig.secretAccessKey!,
    },
    maxAttempts: 1,
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: s3ServerConfig.bucket }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    // Ours already, or someone else's on a shared store — both mean it is there.
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
      if (S3_REQUIRED) throw unreachable(error);
      return null;
    }
  } finally {
    client.destroy();
  }
  return createS3Storage(s3ServerConfig);
}

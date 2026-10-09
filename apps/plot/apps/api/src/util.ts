import type { Context } from 'hono';
import { badRequest, notFound } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params are compared against uuid columns; a malformed id is simply not found. */
export function requireUuidParam(c: Context, name = 'id'): string {
  const value = c.req.param(name);
  if (!value || !UUID_RE.test(value)) throw notFound();
  return value;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('invalid_request', 'Body must be JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('invalid_request', 'Body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw badRequest('invalid_request', `${key} must be a string`);
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest('invalid_request', `${key} must be a string`);
  return value;
}

export function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest('invalid_request', `${key} must be a boolean`);
  return value;
}

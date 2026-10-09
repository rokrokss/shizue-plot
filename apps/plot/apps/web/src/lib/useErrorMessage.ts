'use client';

import { useMessages, useTranslations } from 'next-intl';
import { useCallback, useRef } from 'react';
import { ApiError } from './api';

/**
 * Maps an API error code to a localized string, falling back to the raw
 * developer message the server sent. The returned function keeps a stable
 * identity so it is safe to use as an effect dependency.
 */
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations('errors');
  const messages = useMessages() as Record<string, unknown>;
  const latest = useRef({ t, catalog: (messages['errors'] ?? {}) as Record<string, unknown> });
  latest.current = { t, catalog: (messages['errors'] ?? {}) as Record<string, unknown> };

  return useCallback((error: unknown): string => {
    const { t: translate, catalog } = latest.current;
    if (error instanceof ApiError) {
      // Own keys only: a code can come from the URL, and `constructor` is `in` every object.
      if (Object.hasOwn(catalog, error.code)) return translate(error.code);
      return error.message || translate('unknown');
    }
    if (error instanceof Error && error.message) return error.message;
    return translate('unknown');
  }, []);
}

/** better-auth returns `{error, code}` objects rather than throwing. */
export function authError(error: { code?: string; message?: string } | null | undefined): ApiError {
  const raw = error as (Record<string, unknown> & { code?: string; message?: string }) | null;
  const detail = typeof raw?.['error'] === 'string' ? (raw['error'] as string) : (raw?.message ?? '');
  return new ApiError(0, raw?.code ?? 'auth_error', detail);
}

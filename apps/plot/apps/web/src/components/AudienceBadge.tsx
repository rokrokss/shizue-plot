'use client';

import { useTranslations } from 'next-intl';
import { Badge } from './ui';

/**
 * Who a field in the editors is written for. A creator has to hold exactly one
 * distinction in their head — this text reaches other people, that text only ever
 * reaches the model — and every field in both editors says which it is.
 */
export function PublicBadge() {
  const common = useTranslations('common');

  return <Badge tone="public">{common('audiencePublic')}</Badge>;
}

export function AiBadge() {
  const common = useTranslations('common');

  return <Badge tone="ai">{common('audienceAi')}</Badge>;
}

import { redirect } from '@/i18n/navigation';

/**
 * The catalogue moved to `/`, which is the feed now. This route stays behind so
 * links and bookmarks written while it was the hub still land on it, locale and
 * all.
 */
export default async function ExploreRedirect({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: '/', locale });
}

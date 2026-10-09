/**
 * The shell's three clusters, described once for the header's bar and the phone's
 * tab bar both. A cluster is one destination plus every path that counts as
 * standing inside it — a creator's page belongs to 탐색 though nothing in 탐색
 * links straight to it, and 페르소나 and 노트 belong to 만들기 though they live
 * behind its sub-tabs.
 */
export type NavKey = 'explore' | 'chats' | 'create';

export interface NavCluster {
  key: NavKey;
  /** Where the tab goes; also the path an anonymous reader is sent back to. */
  href: string;
  active: boolean;
  /** Behind the gate: an anonymous reader is offered the way in instead. */
  member: boolean;
}

/** Whether the path is one of these, or something below one of them. */
function under(pathname: string, ...roots: string[]): boolean {
  return roots.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

export function navClusters(pathname: string): NavCluster[] {
  return [
    {
      key: 'explore',
      href: '/',
      active:
        pathname === '/' ||
        under(pathname, '/p', '/creators', '/explore'),
      member: false,
    },
    { key: 'chats', href: '/chats', active: under(pathname, '/chats'), member: true },
    {
      key: 'create',
      href: '/plots',
      active: under(pathname, '/plots', '/personas', '/notes'),
      member: true,
    },
  ];
}

/** Where a tab points for a reader who is not signed in: the way in, and back. */
export function signInHref(back: string): string {
  return authHref('/login', back);
}

/** The other door, with the same return trip. */
export function signUpHref(back: string): string {
  return authHref('/signup', back);
}

/** Both doors already land on `/`, so the front page needs no `next` at all. */
function authHref(door: string, back: string): string {
  return back === '/' ? door : `${door}?next=${encodeURIComponent(back)}`;
}

/**
 * The other end of that trip: where the auth form goes once it is done. Only an
 * internal path is ever followed — `//host` and `/\host` are protocol-relative
 * URLs, an absolute one does not start with a slash at all, and each of them is
 * somebody else's site wearing a query parameter. Anything else is the front
 * door, which is also where a reader with no `next` was headed.
 *
 * Takes what a query string actually hands over: absent, one value, or — for a
 * `?next=` somebody repeated — several.
 */
export function returnTo(next: string | string[] | undefined | null): string {
  if (typeof next !== 'string') return '/';
  return next.startsWith('/') && !/^\/[/\\]/.test(next) ? next : '/';
}

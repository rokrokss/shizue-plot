/**
 * The shell's three clusters, described once for the header's bar and the phone's
 * tab bar both. A cluster is one destination plus every path that counts as
 * standing inside it — a work's page belongs to the library, and 페르소나 and
 * 노트 belong to 만들기 though they live behind its sub-tabs.
 */
export type NavKey = 'library' | 'chats' | 'create';

export interface NavCluster {
  key: NavKey;
  /** Where the tab goes. */
  href: string;
  active: boolean;
}

/**
 * Whether this tab has moved from one of our pages to another since it loaded.
 * A page opened straight — a new tab, a link from elsewhere, a reload — has none
 * of ours behind it, so a back control there must not step off the site.
 */
let movedInApp = false;

/** The shell notes each move to a new path (`(app)/layout.tsx`). */
export function noteMove(): void {
  movedInApp = true;
}

/** Whether the browser's previous entry is one of our pages. */
export function cameInApp(): boolean {
  return movedInApp;
}

/** Whether the path is one of these, or something below one of them. */
function under(pathname: string, ...roots: string[]): boolean {
  return roots.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

export function navClusters(pathname: string): NavCluster[] {
  return [
    { key: 'library', href: '/', active: pathname === '/' || under(pathname, '/p') },
    { key: 'chats', href: '/chats', active: under(pathname, '/chats') },
    {
      key: 'create',
      href: '/plots',
      active: under(pathname, '/plots', '/personas', '/notes'),
    },
  ];
}

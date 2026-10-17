import { createHash } from 'node:crypto';

/**
 * A sandbox frame's document as its route answers it (`app/sandbox/*.html`),
 * with the frame's own policy beside it. A `srcdoc` would take the page's policy
 * on top of that one; a document of ours, loaded into `sandbox="allow-scripts"`,
 * has only its own.
 *
 * Built once per process. A chat mounts a frame per component call, so each one
 * revalidates against the ETag rather than fetching the runtime again, and the
 * runtime a deploy brings is picked up at once.
 */
export function sandboxDocument(build: () => string, policy: string): (request: Request) => Response {
  let built: { body: string; etag: string } | undefined;
  return (request) => {
    built ??= (() => {
      const body = build();
      return { body, etag: `"${createHash('sha256').update(body).digest('base64url')}"` };
    })();
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': policy,
      'Cache-Control': 'no-cache',
      ETag: built.etag,
    };
    if (request.headers.get('if-none-match') === built.etag) return new Response(null, { status: 304, headers });
    return new Response(built.body, { headers });
  };
}

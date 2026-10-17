import { componentFrameCsp, componentFrameDocument } from '@/lib/componentRuntime';
import { sandboxDocument } from '@/lib/sandboxDocument';

/** The component sandbox's document (`ComponentFrame`), in the scheme the frame starts in. */
const light = sandboxDocument(() => componentFrameDocument('light'), componentFrameCsp());
const dark = sandboxDocument(() => componentFrameDocument('dark'), componentFrameCsp());

// Answered per request, so the ETag is ours to check rather than a prerender's.
export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  return (new URL(request.url).searchParams.get('scheme') === 'light' ? light : dark)(request);
}

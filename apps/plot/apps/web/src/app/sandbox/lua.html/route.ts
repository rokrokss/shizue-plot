import { luaFrameCsp, luaFrameDocument } from '@/lib/scripts/lua/sandboxRuntime';
import { sandboxDocument } from '@/lib/sandboxDocument';

/** The Lua sandbox's document (`lib/scripts/lua/sandbox.ts`). */
const lua = sandboxDocument(luaFrameDocument, luaFrameCsp());

// Answered per request, so the ETag is ours to check rather than a prerender's.
export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  return lua(request);
}

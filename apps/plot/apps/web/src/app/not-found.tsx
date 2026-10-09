import { wordmarkFont } from '@/components/Brand';
import './globals.css';

/**
 * Reached only for paths the locale proxy does not rewrite, which means
 * there is no locale here and no message catalogue to read from. So the page
 * says nothing that would need translating: the status code, and the wordmark —
 * fixed brand copy, and the way back to a page that does know the reader's
 * language. `lang` describes the only word on it rather than claiming a reader's
 * language this page has no way of knowing.
 */
export default function NotFound() {
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-dvh flex-col items-center justify-center gap-5">
          <p className="text-2xl font-semibold tracking-tight text-fg tabular-nums">404</p>
          <a
            href="/"
            translate="no"
            className={`${wordmarkFont.className} rounded-lg px-2 py-1 font-extrabold text-3xl tracking-[-0.03em] text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}
          >
            shizue
          </a>
        </main>
      </body>
    </html>
  );
}

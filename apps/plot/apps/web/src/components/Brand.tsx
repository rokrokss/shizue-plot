import { Bricolage_Grotesque } from 'next/font/google';
import { cx } from './ui';

/** The wordmark face from shizue.net, self-hosted at build. `opsz` lets the
 * browser size its optical axis to the text, as the site does. */
export const wordmarkFont = Bricolage_Grotesque({ subsets: ['latin'], axes: ['opsz'], display: 'swap' });

/** The reference mascot stays in the brand; plots keep their own characters. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)} translate="no">
      <span aria-hidden="true" className="brand-mark size-9 shrink-0" />
      <span className={cx(wordmarkFont.className, 'font-extrabold text-[26px] leading-none tracking-[-0.03em]')}>shizue</span>
    </span>
  );
}

export function BrandGarden({ compact = false }: { compact?: boolean }) {
  return (
    <div aria-hidden="true" className={cx('brand-garden', compact && 'brand-garden-compact')}>
      <span className="garden-spark garden-spark-one" />
      <span className="garden-spark garden-spark-two" />
      <div className="garden-window">
        <div className="garden-window-bar"><i /><i /><i /></div>
        <span className="brand-mark garden-mascot" />
        <div className="garden-ground" />
      </div>
      <span className="garden-leaf" />
      <span className="brand-sprite garden-friend" />
    </div>
  );
}

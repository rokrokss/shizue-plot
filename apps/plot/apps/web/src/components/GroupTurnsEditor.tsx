'use client';

import {
  GROUP_ORDERS,
  MAX_GROUP_SPEAKERS,
  MIN_GROUP_SPEAKERS,
  type GroupSettings,
} from '@shizue/core/group';
import { useTranslations } from 'next-intl';
import { Avatar } from './Avatar';
import { Select, cx } from './ui';

/**
 * The 대화량 a creator picks from: sixths of the 0..100 the work stores, as
 * RisuAI's own control steps it. 0 is "only when picked".
 */
export const TALKATIVENESS_STOPS: readonly number[] = [0, 17, 33, 50, 67, 83, 100];

/** The stop a stored value is drawn at: the nearest one, the lower on a tie. */
export function talkativenessStop(value: number): number {
  return TALKATIVENESS_STOPS.reduce((best, stop) => (Math.abs(stop - value) < Math.abs(best - value) ? stop : best));
}

const SPEAKER_COUNTS = Array.from(
  { length: MAX_GROUP_SPEAKERS - MIN_GROUP_SPEAKERS + 1 },
  (_, index) => MIN_GROUP_SPEAKERS + index,
);

/**
 * How a conversation of several members flows: the round's order, how many may
 * answer one turn, and how readily each member joins in. The reader's browser
 * picks every round from these, and each speaker it picks is a generation of
 * its own — which the cost line says. Nothing saves on its own: the studio's one
 * Save carries the settings with the plot and each 대화량 with its member.
 */
export function GroupTurnsEditor({
  settings,
  members,
  onChange,
  onTalkativeness,
}: {
  settings: GroupSettings;
  /** The roster, in its order. */
  members: readonly { id: string; name: string; avatarUrl: string | null; talkativeness: number }[];
  onChange: (settings: GroupSettings) => void;
  onTalkativeness: (memberId: string, value: number) => void;
}) {
  const t = useTranslations('plot');
  const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted">{t('groupFlowHint')}</p>

      <div className="space-y-1.5">
        <span className="block text-xs font-semibold text-muted">{t('groupOrder')}</span>
        <div role="group" aria-label={t('groupOrder')} className="flex flex-wrap gap-1.5">
          {GROUP_ORDERS.map((order) => (
            <button
              key={order}
              type="button"
              data-testid={`group-order-${order}`}
              aria-pressed={settings.order === order}
              onClick={() => onChange({ ...settings, order })}
              className={cx(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                focusRing,
                settings.order === order ? 'border-accent/60 bg-raised text-fg' : 'border-line text-muted hover:text-fg',
              )}
            >
              {t(`groupOrderOptions.${order}`)}
            </button>
          ))}
        </div>
        <span className="block text-xs text-muted">{t(`groupOrderHints.${settings.order}`)}</span>
      </div>

      <label className="block max-w-56 space-y-1.5">
        <span className="block text-xs font-semibold text-muted">{t('groupMaxSpeakers')}</span>
        <Select
          data-testid="group-max-speakers"
          value={String(settings.maxSpeakers)}
          onChange={(event) => onChange({ ...settings, maxSpeakers: Number(event.target.value) })}
        >
          {SPEAKER_COUNTS.map((count) => (
            <option key={count} value={count}>
              {t('groupMaxSpeakersOption', { count })}
            </option>
          ))}
        </Select>
      </label>
      <p className="text-xs text-muted">{t('groupCost')}</p>

      <div className="space-y-3 border-t border-line pt-5">
        <div className="space-y-1">
          <h3 className="text-xs font-semibold text-muted">{t('talkativeness')}</h3>
          <p className="text-xs text-muted">{t('talkativenessHint')}</p>
        </div>
        <ul className="space-y-2">
          {members.map((member) => {
            const at = talkativenessStop(member.talkativeness);
            return (
              <li
                key={member.id}
                data-testid="member-talkativeness"
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
              >
                <span className="flex min-w-0 flex-1 basis-40 items-center gap-2">
                  {/* The name follows; the face is decoration beside it. */}
                  <span aria-hidden="true">
                    <Avatar src={member.avatarUrl} name={member.name} className="size-7 text-xs" />
                  </span>
                  <span className="truncate text-sm text-fg">{member.name}</span>
                </span>
                {/* A meter rather than a slider: seven stops, each a button, the
                    bars up to the chosen one filled — so the level reads at a glance
                    and the readout beside it says it in words. */}
                <span role="group" aria-label={t('talkativeness')} className="flex items-end gap-0.5">
                  {TALKATIVENESS_STOPS.map((stop, index) => (
                    <button
                      key={stop}
                      type="button"
                      aria-pressed={stop === at}
                      aria-label={t('talkativenessStop', { name: member.name, value: stop })}
                      title={stop === 0 ? t('talkativenessZero') : t('talkativenessValue', { value: stop })}
                      onClick={() => onTalkativeness(member.id, stop)}
                      className={cx('flex h-7 w-6 items-end justify-center rounded-sm', focusRing)}
                    >
                      <span
                        aria-hidden="true"
                        style={{ height: `${6 + index * 3}px` }}
                        className={cx('w-2 rounded-sm transition-colors', stop <= at ? 'bg-accent' : 'bg-line')}
                      />
                    </button>
                  ))}
                </span>
                <span className="w-24 text-xs text-muted tabular-nums">
                  {at === 0 ? t('talkativenessZero') : t('talkativenessValue', { value: at })}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

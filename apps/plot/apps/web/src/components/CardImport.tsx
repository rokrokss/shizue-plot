'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { isRestrictiveLicense, licenseTerms, REALM_ORIGIN } from '@/lib/realm';
import type { PlotMember } from '@/lib/types';
import { Button, Checkbox, Field, TextInput } from './ui';

/**
 * A RisuRealm page address and the button that imports it. The download itself
 * is the caller's (`downloadRealmCard`), so the busy state and the error land in
 * the same place as every other import on the page; the address is kept on a
 * failure and cleared once the card is in.
 */
export function RealmImportForm({
  busy = false,
  disabled,
  onSubmit,
}: {
  busy?: boolean;
  disabled?: boolean;
  /** Resolves true once the card is in. */
  onSubmit: (url: string) => Promise<boolean>;
}) {
  const t = useTranslations('cardImport');
  const [url, setUrl] = useState('');

  async function submit(): Promise<void> {
    if (!url.trim() || busy || disabled) return;
    if (await onSubmit(url.trim())) setUrl('');
  }

  return (
    <div data-testid="realm-import" className="space-y-2">
      <Field label={t('realmUrl')} hint={t('realmHint')}>
        <div className="flex gap-2">
          <TextInput
            type="url"
            inputMode="url"
            data-testid="realm-import-url"
            value={url}
            placeholder={t('realmPlaceholder')}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
          <Button
            variant="primary"
            busy={busy}
            disabled={disabled || !url.trim()}
            onClick={() => void submit()}
          >
            {t('realmSubmit')}
          </Button>
        </div>
      </Field>
      <p className="text-xs text-muted/80">
        {t.rich('realmBrowse', {
          link: (chunks) => (
            <a
              href={REALM_ORIGIN}
              target="_blank"
              rel="noreferrer"
              className="text-link underline underline-offset-2"
            >
              {chunks}
            </a>
          ),
        })}
      </p>
    </div>
  );
}

/**
 * A card's license in words: the code as the card wrote it, then what its
 * conditions mean. A card that names none says so — that is not a permission.
 */
export function LicenseText({ license }: { license: string | null }) {
  const t = useTranslations('rights');
  if (!license) return <>{t('licenseNone')}</>;
  if (license.toLowerCase() === 'private') return <>{t('licensePrivate')}</>;
  const terms = licenseTerms(license);
  return <>{[license, ...terms.map((term) => t(`terms.${term}`))].join(' · ')}</>;
}

/**
 * Where an imported member came from, who the card says made it and under what
 * license — what the owner weighs before publishing it. Nothing here is checked:
 * the creator and license are the card's own claims, the source the importer's.
 */
export function ImportedCardDetails({ member }: { member: PlotMember }) {
  const t = useTranslations('rights');
  const source = member.importedFrom;
  if (!source) return null;

  return (
    <div
      data-testid="member-provenance"
      className="space-y-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-xs"
    >
      <p className="font-medium text-fg">{t('importedTitle')}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
        <dt>{t('source')}</dt>
        <dd className="break-all text-fg">
          {source.sourceUrl ? (
            <a
              href={source.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-link underline underline-offset-2"
            >
              {source.sourceUrl}
            </a>
          ) : (
            t('sourceFile', { name: source.fileName })
          )}
        </dd>
        <dt>{t('creator')}</dt>
        <dd className="text-fg">{member.card.creator.trim() || t('creatorUnknown')}</dd>
        <dt>{t('license')}</dt>
        <dd className="text-fg" data-testid="member-license">
          <LicenseText license={member.license} />
        </dd>
      </dl>
      {isRestrictiveLicense(member.license) ? (
        <p className="text-danger">{t('restrictedNotice')}</p>
      ) : null}
    </div>
  );
}

/**
 * The owner's word, asked for wherever imported characters are about to reach
 * readers: a publish of a plot that has them, and an import into a plot that is
 * already public. `restricted` names the members whose license asks for more
 * than a word — the warning is stronger, the box is the same.
 */
export function RightsConfirmation({
  notice,
  label,
  restricted = [],
  checked,
  onChange,
}: {
  notice: string;
  /** The words the owner checks, which say what is about to be published. */
  label: string;
  restricted?: string[];
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useTranslations('rights');

  return (
    <div data-testid="rights-confirmation" className="space-y-2 rounded-lg border border-line bg-canvas/40 p-3">
      <p className="text-xs text-muted">{notice}</p>
      {restricted.length > 0 ? (
        <p data-testid="rights-restricted" className="text-xs text-danger">
          {t('restrictedPublish', { names: restricted.join(', ') })}
        </p>
      ) : null}
      <Checkbox label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

'use client';

/**
 * The paste migration's screens around the form — the confirmations, the images,
 * the preview and the run — as the wizard page arranges them. They draw what the
 * page holds; the decisions and the requests are `lib/migrate`.
 */
import type {
  ConfirmationItem,
  MigrationDraft,
  MigrationPlatform,
  MigrationResult,
  MigrationWarning,
  SiteSchema,
  SpeakerMode,
} from '@shizue/core/migrate';
import { parseAssistantSpeech } from '@shizue/core/speech';
import { useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { MAX_ASSET_NAME_LENGTH, MAX_ASSETS } from '@/lib/assets';
import type { MigrationStep, RunState, StepResult } from '@/lib/migrate/run';
import {
  fieldLabel,
  imageListDefault,
  isBlocked,
  referenceFromFileName,
  SPEAKER_MODES,
  type PreviewOptions,
  type WizardImage,
} from '@/lib/migrate/wizard';
import type { PlotStyle } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Avatar } from './Avatar';
import { useWarningText } from './MigrationForm';
import { Badge, Button, buttonClass, Checkbox, cx, Field, Select, Spinner, TextInput } from './ui';

const PANEL = 'rounded-2xl border border-line bg-surface p-5 sm:p-6';

/** A warning's sentence after the source's name for the field it is about. */
function useLabelledWarning(schema: SiteSchema): (warning: MigrationWarning) => string {
  const warningText = useWarningText();
  return (warning) => {
    const label = warning.field ? fieldLabel(schema, warning.field) : null;
    return label ? `${label}: ${warningText(warning)}` : warningText(warning);
  };
}

// ── confirm ─────────────────────────────────────────────────────────────────

export function ConfirmStep({
  platform,
  items,
  checked,
  onCheck,
  sourceUrl,
  sourceUrlValid,
  onSourceUrl,
}: {
  platform: MigrationPlatform;
  items: ConfirmationItem[];
  checked: Record<string, boolean>;
  onCheck: (id: string, value: boolean) => void;
  sourceUrl: string;
  sourceUrlValid: boolean;
  onSourceUrl: (value: string) => void;
}) {
  const t = useTranslations('migrate');
  const blocked = isBlocked(items);

  return (
    <div className="space-y-4" data-testid="migrate-confirm">
      <section className={cx(PANEL, 'space-y-3')}>
        <h2 className="heading3 text-fg">{t('confirmStep.title')}</h2>
        <p className="text-xs text-muted">{t('confirmStep.hint')}</p>
        <ul className="space-y-2">
          {items.map((item) =>
            item.blocking ? (
              <li key={item.id} className="rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger">
                {t(`confirm.${item.id}`)}
              </li>
            ) : (
              <li key={item.id} data-testid="migrate-confirm-item" data-id={item.id}>
                <Checkbox
                  label={t(`confirm.${item.id}`)}
                  checked={checked[item.id] === true}
                  onChange={(value) => onCheck(item.id, value)}
                />
              </li>
            ),
          )}
        </ul>
        {blocked ? <p className="text-sm text-danger">{t('confirmStep.blocked')}</p> : null}
      </section>

      <section className={cx(PANEL, 'space-y-2')}>
        <Field label={t('confirmStep.sourceUrl')} hint={t('confirmStep.sourceUrlHint')}>
          <TextInput
            type="url"
            inputMode="url"
            data-testid="migrate-source-url"
            className="w-full"
            value={sourceUrl}
            placeholder={t(`confirmStep.sourceUrlPlaceholder.${platform}`)}
            aria-invalid={!sourceUrlValid || undefined}
            onChange={(event) => onSourceUrl(event.target.value)}
          />
        </Field>
        <p aria-live="polite" className="text-xs text-danger">
          {sourceUrlValid ? '' : t('confirmStep.sourceUrlInvalid', { platform: t(`platforms.${platform}`) })}
        </p>
      </section>
    </div>
  );
}

// ── images ──────────────────────────────────────────────────────────────────

/** Accepted like the asset manager's picker; the API checks the bytes again. */
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

let nextImageId = 0;

export function ImagesStep({
  images,
  urls,
  memberNames,
  restoredWithoutImages,
  onChange,
}: {
  images: WizardImage[];
  /** Object URLs for the thumbnails, by image id. */
  urls: ReadonlyMap<string, string>;
  memberNames: string[];
  /** The saved form came back, and the images it had did not. */
  restoredWithoutImages: boolean;
  onChange: (images: WizardImage[]) => void;
}) {
  const t = useTranslations('migrate.images');
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function add(files: File[]): void {
    const picked = files.filter((file) => file.type.startsWith('image/'));
    const room = MAX_ASSETS - images.length;
    onChange([
      ...images,
      ...picked.slice(0, Math.max(0, room)).map((file) => ({
        id: `image-${(nextImageId += 1)}`,
        file,
        name: referenceFromFileName(file.name).slice(0, MAX_ASSET_NAME_LENGTH),
        description: '',
        avatarOf: null,
      })),
    ]);
  }

  const update = (id: string, patch: Partial<WizardImage>): void =>
    onChange(images.map((image) => (image.id === id ? { ...image, ...patch } : image)));

  return (
    <div className="space-y-4" data-testid="migrate-images">
      <section
        className={cx(PANEL, 'space-y-3', over && 'border-fg bg-mint-soft/40')}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          add([...event.dataTransfer.files]);
        }}
      >
        <h2 className="heading3 text-fg">{t('title')}</h2>
        <p className="text-sm text-muted">{t('hint')}</p>
        <input
          ref={input}
          data-testid="migrate-image-input"
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            add(files);
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={images.length >= MAX_ASSETS} onClick={() => input.current?.click()}>
            {t('pick')}
          </Button>
          <span className="text-xs text-muted">{t('drop')}</span>
          <span className="ml-auto text-xs text-muted tabular-nums">
            {t('count', { count: images.length, max: MAX_ASSETS })}
          </span>
        </div>
        <p className={cx('text-xs', restoredWithoutImages ? 'text-danger' : 'text-muted')}>
          {restoredWithoutImages ? t('readd') : t('notSaved')}
        </p>
      </section>

      {images.length > 0 ? (
        <ul className="space-y-3">
          {images.map((image) => (
            <li
              key={image.id}
              data-testid="migrate-image"
              className={cx(PANEL, 'flex flex-col gap-4 sm:flex-row')}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={urls.get(image.id)}
                alt=""
                className="aspect-[2/3] w-24 shrink-0 rounded-xl border border-line bg-raised object-contain"
              />
              <div className="min-w-0 flex-1 space-y-3">
                <Field label={t('name')} hint={t('nameHint', { name: image.name || '…' })}>
                  <TextInput
                    data-testid="migrate-image-name"
                    className="w-full"
                    value={image.name}
                    maxLength={MAX_ASSET_NAME_LENGTH}
                    onChange={(event) => update(image.id, { name: event.target.value })}
                  />
                </Field>
                <Field label={t('description')} hint={t('descriptionHint')}>
                  <TextInput
                    data-testid="migrate-image-description"
                    className="w-full"
                    value={image.description}
                    onChange={(event) => update(image.id, { description: event.target.value })}
                  />
                </Field>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={t('avatar')}>
                    <Select
                      data-testid="migrate-image-avatar"
                      value={image.avatarOf === null ? '' : String(image.avatarOf)}
                      onChange={(event) =>
                        update(image.id, { avatarOf: event.target.value === '' ? null : Number(event.target.value) })
                      }
                    >
                      <option value="">{t('avatarNone')}</option>
                      {memberNames.map((name, index) => (
                        <option key={index} value={index}>
                          {name || t('memberUnnamed', { number: index + 1 })}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => onChange(images.filter((each) => each.id !== image.id))}
                  >
                    {t('remove')}
                  </Button>
                </div>
                {image.avatarOf !== null ? <p className="text-xs text-muted">{t('avatarNote')}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── preview ─────────────────────────────────────────────────────────────────

/** Scene text as the chat will split it: who says each part. */
function SpeechPreview({ text, roster }: { text: string; roster: string[] }) {
  const t = useTranslations('migrate.preview');
  const blocks = parseAssistantSpeech(text, roster);
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block, index) =>
        block.speaker.kind === 'character' ? (
          <div key={index} data-testid="migrate-speech-character" data-speaker={block.speaker.name}>
            <p className="text-xs font-medium text-link">{block.speaker.name}</p>
            <p className="whitespace-pre-wrap text-fg">
              {block.parts.map((part, at) =>
                part.kind === 'description' ? (
                  <em key={at} className="text-muted">
                    {` ${part.text} `}
                  </em>
                ) : (
                  <span key={at}>{part.text}</span>
                ),
              )}
            </p>
          </div>
        ) : (
          <div key={index} data-testid="migrate-speech-narration">
            <p className="text-xs text-muted">
              {block.speaker.kind === 'user' ? t('speakerUser') : t('speakerNarrator')}
            </p>
            <p className="whitespace-pre-wrap italic text-muted">
              {block.parts.map((part) => part.text).join(' ')}
            </p>
          </div>
        ),
      )}
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted">{label}</p>
      {children}
    </div>
  );
}

function Prose({ text }: { text: string }) {
  const t = useTranslations('migrate.preview');
  return text.trim() ? (
    <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-fg">{text}</p>
  ) : (
    <p className="text-sm text-muted">{t('empty')}</p>
  );
}

/** The style the draft sets, as the style editor names its options. */
function StyleSummary({ style, draft }: { style: PlotStyle | undefined; draft: MigrationDraft }) {
  const t = useTranslations('style');
  const plot = useTranslations('plot');
  const preview = useTranslations('migrate.preview');
  const rows: [string, string][] = [];
  if (style?.tense) rows.push([t('tense'), t(`tenseOptions.${style.tense}`)]);
  if (style?.replyLength) rows.push([t('replyLength'), t(`replyLengthOptions.${style.replyLength}`)]);
  if (style?.delivery) rows.push([t('delivery'), t(`deliveryOptions.${style.delivery}`)]);
  if (style?.pacing) rows.push([t('pacing'), t(`pacingOptions.${style.pacing}`)]);
  if (style?.difficulty) rows.push([t('difficulty'), t(`difficultyOptions.${style.difficulty}`)]);
  if (style?.moods?.length) rows.push([t('moods'), style.moods.map((mood) => t(`moodOptions.${mood}`)).join(', ')]);
  if (style?.storytelling) rows.push([t('storytelling'), t(`storytellingOptions.${style.storytelling}`)]);
  if (style?.statusWindow) rows.push([t('statusWindow'), t('statusWindowLabel')]);
  if (style?.choices) rows.push([t('choices'), t(`choicesOptions.${style.choices}`)]);
  const pov = draft.plot.narrator?.pov;
  if (pov) rows.push([plot('narratorPov'), t(`badges.${pov}`)]);
  if (rows.length === 0) return <p className="text-sm text-muted">{preview('styleNone')}</p>;
  return (
    <dl data-testid="migrate-preview-style" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PreviewStep({
  platform,
  schema,
  result,
  options,
  onOptions,
  scenes,
  avatars,
  existing,
}: {
  platform: MigrationPlatform;
  schema: SiteSchema;
  result: MigrationResult;
  options: PreviewOptions;
  onOptions: (options: PreviewOptions) => void;
  /** The scene fields with text, labelled as the source names them. */
  scenes: { path: string; label: string }[];
  /** Avatar thumbnails by member index. */
  avatars: ReadonlyMap<number, string>;
  /** Plots an earlier migration of this same draft made. */
  existing: string[];
}) {
  const t = useTranslations('migrate.preview');
  const plot = useTranslations('plot');
  const labelled = useLabelledWarning(schema);
  const { draft, warnings } = result;
  const roster = draft.members.map((member) => member.name);
  const set = (patch: Partial<PreviewOptions>): void => onOptions({ ...options, ...patch });

  return (
    <div className="space-y-4" data-testid="migrate-preview">
      {existing.length > 0 ? (
        <p data-testid="migrate-already-imported" className="rounded-xl border border-danger/40 bg-surface px-4 py-3 text-sm text-danger">
          {t.rich('alreadyImported', {
            link: (chunks) => (
              <Link href={`/plots/${existing[0]}`} className="text-link underline underline-offset-2">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : null}

      <section className={cx(PANEL, 'space-y-3')} data-testid="migrate-warnings">
        <h2 className="heading3 text-fg">{t('warnings')}</h2>
        {warnings.length === 0 ? (
          <p className="text-sm text-muted">{t('noWarnings')}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
            {warnings.map((warning, index) => (
              <li key={index} data-testid="migrate-warning" data-code={warning.code}>
                {labelled(warning)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={cx(PANEL, 'space-y-4')}>
        <h2 className="heading3 text-fg">{t('convert')}</h2>
        {scenes.length > 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">{t('speakerHint')}</p>
            <ul className="space-y-3">
              {scenes.map((scene) => (
                <li
                  key={scene.path}
                  data-testid="migrate-speaker"
                  data-path={scene.path}
                  className="flex flex-wrap items-end gap-3"
                >
                  <span className="min-w-0 flex-1 basis-40 text-sm text-fg">{scene.label}</span>
                  <Field label={t('speakerMode')}>
                    <Select
                      data-testid="migrate-speaker-mode"
                      value={options.speaker[scene.path] ?? 'auto'}
                      onChange={(event) =>
                        set({ speaker: { ...options.speaker, [scene.path]: event.target.value as SpeakerMode } })
                      }
                    >
                      {SPEAKER_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {t(`speakerModes.${mode}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('mainSpeaker')}>
                    <Select
                      data-testid="migrate-main-speaker"
                      value={String(options.mainSpeaker[scene.path] ?? '')}
                      disabled={roster.length === 0}
                      onChange={(event) => {
                        const { [scene.path]: _, ...rest } = options.mainSpeaker;
                        set({
                          mainSpeaker:
                            event.target.value === ''
                              ? rest
                              : { ...rest, [scene.path]: Number(event.target.value) },
                        });
                      }}
                    >
                      <option value="">{t('mainSpeakerAuto')}</option>
                      {roster.map((name, index) => (
                        <option key={index} value={index}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="space-y-2">
          <Checkbox
            label={t('normalizeBraces')}
            checked={options.normalizeBraces}
            onChange={(normalizeBraces) => set({ normalizeBraces })}
          />
          <div className="space-y-1">
            <Checkbox
              label={t('imageListLore')}
              checked={options.imageListLore ?? imageListDefault(platform, warnings)}
              onChange={(imageListLore) => set({ imageListLore })}
            />
            <p className="pl-6 text-xs text-muted">{t('imageListLoreHint')}</p>
          </div>
          {platform === 'elyn' ? (
            <Checkbox
              label={t('splitSections')}
              checked={options.splitSections}
              onChange={(splitSections) => set({ splitSections })}
            />
          ) : null}
        </div>
      </section>

      <section className={cx(PANEL, 'space-y-4')} data-testid="migrate-preview-plot">
        <h2 className="heading3 text-fg">{plot('profile')}</h2>
        <Labelled label={plot('name')}>
          <p className="body1 font-semibold text-fg" data-testid="migrate-preview-name">
            {draft.plot.name || t('empty')}
          </p>
        </Labelled>
        <Labelled label={plot('intro')}>
          <Prose text={draft.plot.intro} />
        </Labelled>
        {draft.plot.tags.length > 0 ? (
          <Labelled label={plot('tags')}>
            <ul className="flex flex-wrap gap-1.5">
              {draft.plot.tags.map((tag) => (
                <li key={tag}>
                  <Badge tone="public">{tag}</Badge>
                </li>
              ))}
            </ul>
          </Labelled>
        ) : null}
        <Labelled label={plot('description')}>
          <Prose text={draft.plot.description} />
        </Labelled>
        {draft.plot.narrator?.voice ? (
          <Labelled label={plot('narratorVoice')}>
            <Prose text={draft.plot.narrator.voice} />
          </Labelled>
        ) : null}
        <Labelled label={plot('style')}>
          <StyleSummary style={draft.plot.style} draft={draft} />
        </Labelled>
        {draft.plot.customUi?.componentCode ? (
          <Labelled label={plot('componentCode')}>
            <p className="text-sm text-fg">
              {t('componentCode', { count: draft.plot.customUi.componentCode.length })}
            </p>
          </Labelled>
        ) : null}
      </section>

      <section className={cx(PANEL, 'space-y-4')} data-testid="migrate-preview-members">
        <h2 className="heading3 text-fg">
          {plot('members')} <span className="text-xs font-normal text-muted">{draft.members.length}</span>
        </h2>
        {draft.members.length === 0 ? <p className="text-sm text-danger">{t('noMembers')}</p> : null}
        <ul className="space-y-4">
          {draft.members.map((member, index) => (
            <li key={index} data-testid="migrate-preview-member" className="space-y-3 border-t border-line pt-4 first:border-0 first:pt-0">
              <div className="flex items-center gap-3">
                <Avatar src={avatars.get(index) ?? null} name={member.name} className="size-10 text-sm" />
                <p className="text-sm font-medium text-fg">{member.name}</p>
              </div>
              {member.intro ? (
                <Labelled label={plot('memberIntro')}>
                  <Prose text={member.intro} />
                </Labelled>
              ) : null}
              <Labelled label={plot('memberDescription')}>
                <Prose text={member.description} />
              </Labelled>
              {member.personality ? (
                <Labelled label={plot('memberPersonality')}>
                  <Prose text={member.personality} />
                </Labelled>
              ) : null}
              {member.mesExample ? (
                <Labelled label={plot('memberMesExample')}>
                  <div className="max-h-64 overflow-y-auto rounded-xl bg-canvas/60 p-3">
                    <SpeechPreview text={member.mesExample} roster={roster} />
                  </div>
                </Labelled>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className={cx(PANEL, 'space-y-4')} data-testid="migrate-preview-intros">
        <h2 className="heading3 text-fg">{plot('intros')}</h2>
        {draft.plot.intros.length === 0 ? <p className="text-sm text-muted">{t('empty')}</p> : null}
        {draft.plot.intros.map((intro, index) => (
          <Labelled key={index} label={plot('introLabel', { index: index + 1 })}>
            <div className="max-h-96 overflow-y-auto rounded-xl bg-canvas/60 p-3" data-testid="migrate-preview-intro">
              <SpeechPreview text={intro} roster={roster} />
            </div>
          </Labelled>
        ))}
      </section>

      <section className={cx(PANEL, 'space-y-3')} data-testid="migrate-preview-lorebook">
        <h2 className="heading3 text-fg">
          {plot('lorebook')} <span className="text-xs font-normal text-muted">{draft.plot.lorebook.length}</span>
        </h2>
        {draft.plot.lorebook.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">{plot('loreKeys')}</th>
                  <th className="py-1 pr-3 font-medium">{plot('loreContent')}</th>
                  <th className="py-1 font-medium">{t('loreState')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line align-top">
                {draft.plot.lorebook.map((entry, index) => (
                  <tr key={index} data-testid="migrate-preview-lore">
                    <td className="py-2 pr-3 text-fg">{entry.keys.join(', ') || '—'}</td>
                    <td className="py-2 pr-3 whitespace-pre-wrap text-fg">
                      <span className="line-clamp-4">{entry.content}</span>
                    </td>
                    <td className="py-2 text-xs whitespace-nowrap text-muted">
                      {[
                        entry.constant ? plot('loreConstant') : null,
                        entry.enabled === false ? t('loreDisabled') : null,
                        t('loreLength', { count: entry.content.length }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {draft.plot.profiles && draft.plot.profiles.length > 0 ? (
        <section className={cx(PANEL, 'space-y-3')} data-testid="migrate-preview-profiles">
          <h2 className="heading3 text-fg">{plot('profiles')}</h2>
          <ul className="space-y-3">
            {draft.plot.profiles.map((profile, index) => (
              <li key={index} className="space-y-1">
                <p className="text-sm font-medium text-fg">{profile.name}</p>
                <Prose text={profile.description} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ── run ─────────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<StepResult['status'], string> = {
  pending: 'text-muted',
  running: 'text-fg',
  done: 'text-link',
  failed: 'text-danger',
};

function stepLabel(
  step: MigrationStep,
  draft: MigrationDraft,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (step.kind === 'create') return t('kinds.create');
  if (step.kind === 'avatar') return t('kinds.avatar', { name: draft.members[step.member]?.name ?? '' });
  return t('kinds.asset', { name: step.image.name });
}

/** Saves the preserved source text as a file, here, without a request. */
function download(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function RunStep({
  platform,
  schema,
  steps,
  state,
  running,
  result,
  preservedText,
  savedLeft,
  onRetry,
  onClearSaved,
  onBack,
}: {
  platform: MigrationPlatform;
  schema: SiteSchema;
  steps: MigrationStep[];
  state: RunState;
  running: boolean;
  /** The conversion the run was started from. */
  result: MigrationResult;
  preservedText: string;
  /** A saved copy of the form still exists (the plot was not made yet). */
  savedLeft: boolean;
  onRetry: () => void;
  onClearSaved: () => void;
  /** Back to the preview — only while there is no plot yet. */
  onBack: () => void;
}) {
  const t = useTranslations('migrate.run');
  const toMessage = useErrorMessage();
  const labelled = useLabelledWarning(schema);
  const status = (step: MigrationStep): StepResult => state.results[step.id] ?? { status: 'pending' };
  const finished = steps.filter((step) => ['done', 'failed'].includes(status(step).status)).length;
  const failed = steps.filter((step) => status(step).status === 'failed').length;
  const percent = steps.length === 0 ? 100 : Math.round((finished / steps.length) * 100);
  const created = state.plotId !== null;
  const complete = !running && steps.every((step) => status(step).status === 'done');

  return (
    <div className="space-y-4" data-testid="migrate-run" data-running={running || undefined}>
      <section className={cx(PANEL, 'space-y-3')}>
        <p role="status" className="text-sm text-fg">
          {running
            ? t('working')
            : complete
              ? t('done')
              : created
                ? t('partial', { count: failed })
                : t('createFailed')}
        </p>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('progressLabel')}
          className="h-2 overflow-hidden rounded-full bg-raised"
        >
          <div className="h-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
        </div>
        <ul className="divide-y divide-line">
          {steps.map((step) => {
            const result_ = status(step);
            return (
              <li
                key={step.id}
                data-testid="migrate-step"
                data-kind={step.kind}
                data-status={result_.status}
                className="space-y-0.5 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-sm text-fg">{stepLabel(step, result.draft, t)}</span>
                  <span className={cx('text-xs font-medium', STATUS_TONE[result_.status])}>
                    {t(`status.${result_.status}`)}
                  </span>
                  {result_.status === 'running' ? <Spinner /> : null}
                </div>
                {result_.error ? <p className="text-xs text-danger">{toMessage(result_.error)}</p> : null}
              </li>
            );
          })}
        </ul>
        {!running ? (
          <div className="flex flex-wrap justify-end gap-2">
            {!created ? <Button onClick={onBack}>{t('back')}</Button> : null}
            {failed > 0 ? (
              <Button data-testid="migrate-retry" onClick={onRetry}>
                {t('retry')}
              </Button>
            ) : null}
            {created ? (
              <Link
                href={`/plots/${state.plotId}`}
                data-testid="migrate-open-studio"
                className={buttonClass('primary')}
              >
                {t('openStudio')}
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>

      {created && !running ? (
        <>
          {!savedLeft || result.warnings.length > 0 ? (
            <section className={cx(PANEL, 'space-y-2')} data-testid="migrate-result">
              {savedLeft ? null : <p className="text-xs text-muted">{t('savedCleared')}</p>}
              {result.warnings.length > 0 ? (
                <details className="text-sm">
                  <summary className="cursor-pointer text-fg">
                    {t('warningsSummary', { count: result.warnings.length })}
                  </summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">
                    {result.warnings.map((warning, index) => (
                      <li key={index}>{labelled(warning)}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>
          ) : null}

          <section className={cx(PANEL, 'space-y-2')} data-testid="migrate-preserved">
            <h2 className="heading3 text-fg">{t('preserved')}</h2>
            {result.preserved.length === 0 ? (
              <p className="text-sm text-muted">{t('preservedNone')}</p>
            ) : (
              <>
                <p className="text-xs text-muted">{t('preservedHint')}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {result.preserved.map((item, index) => (
                    <li key={index}>
                      <Badge>{item.label}</Badge>
                    </li>
                  ))}
                </ul>
                <Button
                  data-testid="migrate-preserved-download"
                  onClick={() => download(preservedText, `shizue-${platform}-preserved.txt`)}
                >
                  {t('preservedDownload')}
                </Button>
              </>
            )}
          </section>
        </>
      ) : null}

      {savedLeft && !running ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClearSaved}>
            {t('clearSaved')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

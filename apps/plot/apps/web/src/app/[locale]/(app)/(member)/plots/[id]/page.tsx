'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { AssetManager } from '@/components/AssetManager';
import { AiBadge, PublicBadge } from '@/components/AudienceBadge';
import { Avatar } from '@/components/Avatar';
import { ComponentCodeEditor } from '@/components/ComponentCodeEditor';
import { DefaultVariablesEditor, DisplayScriptEditor } from '@/components/DisplayScriptEditor';
import { LorebookEditor } from '@/components/LorebookEditor';
import { LorebookFileActions } from '@/components/LorebookFileActions';
import { PlotStyleEditor } from '@/components/PlotStyleEditor';
import { TagInput } from '@/components/TagInput';
import {
  Button,
  buttonClass,
  CenteredMessage,
  Checkbox,
  ErrorText,
  Field,
  Section,
  Select,
  Spinner,
  TextArea,
  TextInput,
} from '@/components/ui';
import { Link, useRouter } from '@/i18n/navigation';
import { locales } from '@/i18n/routing';
import { apiDelete, apiGet, apiSend, apiUpload } from '@/lib/api';
import {
  MAX_CHARACTERS_PER_PLOT,
  MAX_INTRO_TEXT_LENGTH,
  MAX_INTROS_PER_PLOT,
  MAX_PLOT_PROFILE_DESCRIPTION_LENGTH,
  MAX_PLOT_PROFILE_NAME_LENGTH,
  MAX_PLOT_PROFILES,
  type Chat,
  type ComponentCapability,
  type ContentLanguage,
  type DisplayScript,
  type LoreEntry,
  type NarratorConfig,
  type NormalizedCard,
  type SafetyLevel,
  type PlotDetail,
  type PlotMember,
  type PlotProfile,
  type PlotStyle,
} from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';

/** The card fields the roster editor writes; the rest of the card is carried. */
const memberFields = (member: PlotMember): string =>
  JSON.stringify([
    member.name,
    member.card.intro ?? '',
    member.card.description,
    member.card.personality,
    member.card.mesExample,
  ]);

/**
 * The plot studio: one work, everything in it. The plot's own fields and its
 * members' cards are edited here and committed together by the one Save; the
 * pictures, the roster's shape and the publish switch answer for themselves,
 * because each of those is a request whose result the creator has to see.
 */
export default function PlotStudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('plot');
  const plots = useTranslations('plots');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();
  const router = useRouter();

  const [plot, setPlot] = useState<PlotDetail | null>(null);
  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<ContentLanguage>('ko');
  const [tags, setTags] = useState<string[]>([]);
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  const [intros, setIntros] = useState<string[]>([]);
  const [narrator, setNarrator] = useState<NarratorConfig | null>(null);
  const [style, setStyle] = useState<PlotStyle | null>(null);
  const [profiles, setProfiles] = useState<PlotProfile[]>([]);
  const [lorebook, setLorebook] = useState<LoreEntry[]>([]);
  const [scripts, setScripts] = useState<DisplayScript[]>([]);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [componentCode, setComponentCode] = useState('');
  const [capabilities, setCapabilities] = useState<ComponentCapability[]>([]);
  /** The roster as it is being edited, and as the server last answered with it. */
  const [members, setMembers] = useState<PlotMember[]>([]);
  const [saved, setSaved] = useState<Map<string, string>>(new Map());

  const [error, setError] = useState('');
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mutating, setMutating] = useState(false);
  const locked = saving || mutating;
  const [justSaved, setJustSaved] = useState(false);
  const saveNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (saveNoticeTimer.current !== null) clearTimeout(saveNoticeTimer.current);
  }, []);
  // The saved name, not the one being typed into the heading — the tab has no
  // business flickering along with a rename that has not been committed.
  useDocumentTitle(plot?.name);

  /** Everything the server just said, taken as the state of the editor. */
  const adopt = useCallback((detail: PlotDetail) => {
    setPlot(detail);
    setName(detail.name);
    setIntro(detail.intro);
    setDescription(detail.description);
    setLanguage(detail.language);
    setTags(detail.tags);
    setCommentsEnabled(detail.commentsEnabled);
    setIntros(detail.intros);
    setNarrator(detail.narrator);
    setStyle(detail.style);
    setProfiles(detail.profiles);
    setLorebook(detail.lorebook);
    setScripts(detail.customUi?.displayScripts ?? []);
    setVariables(detail.customUi?.defaultVariables ?? {});
    setComponentCode(detail.customUi?.componentCode ?? '');
    setCapabilities(detail.customUi?.componentCapabilities ?? []);
    setMembers(detail.characters);
    setSaved(new Map(detail.characters.map((member) => [member.id, memberFields(member)])));
  }, []);

  /** The plot row alone — a cover upload or a publish leaves the editor alone. */
  const adoptPlot = useCallback((detail: PlotDetail) => {
    setPlot(detail);
  }, []);

  useEffect(() => {
    apiGet<PlotDetail>(`/api/plots/${id}`).then(adopt, () => setMissing(true));
  }, [id, adopt]);

  async function save(): Promise<void> {
    if (locked) return;
    // A previous confirmation must never stand in for this write finishing.
    if (saveNoticeTimer.current !== null) clearTimeout(saveNoticeTimer.current);
    setJustSaved(false);
    setSaving(true);
    setError('');
    try {
      // The members first: the plot read that follows carries the roster, so
      // adopting it after the writes is what leaves the editor consistent.
      for (const member of members) {
        if (saved.get(member.id) === memberFields(member)) continue;
        await apiSend<PlotMember>('PATCH', `/api/plots/${id}/characters/${member.id}`, {
          name: member.name.trim() || member.card.name,
          card: member.card,
        });
      }
      adopt(
        await apiSend<PlotDetail>('PATCH', `/api/plots/${id}`, {
          name: name.trim() || plot?.name,
          intro,
          description,
          language,
          tags,
          commentsEnabled,
          intros,
          narrator,
          style,
          profiles,
          lorebook,
          customUi: {
            displayScripts: scripts,
            defaultVariables: variables,
            componentCode,
            componentCapabilities: capabilities,
          },
        }),
      );
      setJustSaved(true);
      saveNoticeTimer.current = setTimeout(() => setJustSaved(false), 2000);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (locked) return;
    if (!window.confirm(plots('confirmDelete'))) return;
    setMutating(true);
    try {
      await apiDelete(`/api/plots/${id}`);
      router.push('/plots');
    } catch (caught) {
      setError(toMessage(caught));
      setMutating(false);
    }
  }

  const patchMember = (memberId: string, patch: Partial<NormalizedCard>, memberName?: string): void =>
    setMembers((current) =>
      current.map((member) =>
        member.id === memberId
          ? {
              ...member,
              ...(memberName === undefined ? {} : { name: memberName }),
              card: { ...member.card, ...patch },
            }
          : member,
      ),
    );

  /** A new member joins the roster on the server first, so the cap is the API's. */
  async function addMember(): Promise<void> {
    if (locked) return;
    setMutating(true);
    setError('');
    try {
      const created = await apiSend<PlotMember>('POST', `/api/plots/${id}/characters`, {
        name: t('memberNewName'),
      });
      setMembers((current) => [...current, created]);
      setSaved((current) => new Map(current).set(created.id, memberFields(created)));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setMutating(false);
    }
  }

  async function importMember(file: File): Promise<void> {
    if (locked) return;
    setMutating(true);
    setError('');
    try {
      const created = await apiUpload<PlotMember>(
        `/api/plots/${id}/characters/import`,
        file,
      );
      setMembers((current) => [...current, created]);
      setSaved((current) => new Map(current).set(created.id, memberFields(created)));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setMutating(false);
    }
  }

  async function removeMember(memberId: string): Promise<void> {
    if (locked) return;
    if (!window.confirm(common('confirmDelete'))) return;
    setMutating(true);
    setError('');
    try {
      await apiDelete(`/api/plots/${id}/characters/${memberId}`);
      setMembers((current) => current.filter((member) => member.id !== memberId));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setMutating(false);
    }
  }

  /**
   * Moving a member is an order, not an edit: the request names the whole roster
   * and the answer is discarded, so a card being written in another row is not
   * overwritten by the version the server still has.
   */
  async function move(index: number, delta: number): Promise<void> {
    if (locked) return;
    const next = [...members];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setMembers(next);
    setMutating(true);
    setError('');
    try {
      await apiSend('POST', `/api/plots/${id}/characters/reorder`, {
        ids: next.map((member) => member.id),
      });
    } catch (caught) {
      setMembers(members);
      setError(toMessage(caught));
    } finally {
      setMutating(false);
    }
  }

  if (missing) return <CenteredMessage>{t('notFound')}</CenteredMessage>;
  if (!plot) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={common('loading')} />
      </div>
    );
  }

  return (
    <fieldset disabled={locked} aria-busy={locked || undefined} className="mx-auto min-w-0 w-full max-w-6xl px-5 py-10">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <input
              aria-label={t('name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-w-0 flex-1 truncate border-none bg-transparent title2 sm:title1 text-fg focus:outline-none"
            />
            <PublicBadge />
          </div>
          <p className="text-xs text-muted">{plot.id}</p>
        </div>
        <div className="flex items-center gap-2">
          {mutating ? <Spinner label={common('loading')} /> : null}
          {justSaved ? <span className="text-xs text-link">{common('saved')}</span> : null}
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            {common('save')}
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title={t('profile')}>
            {/* First, because it is the first thing a reader sees of the work. */}
            <Field label={t('intro')} hint={t('introHint')} badge={<PublicBadge />}>
              <TextArea
                rows={3}
                value={intro}
                placeholder={t('introPlaceholder')}
                onChange={(event) => setIntro(event.target.value)}
              />
            </Field>
            <CoverPicker plot={plot} onChange={adoptPlot} onBusyChange={setMutating} />
            <Field label={t('tags')} hint={t('tagsHint')} badge={<PublicBadge />}>
              <TagInput value={tags} placeholder={t('tagPlaceholder')} onChange={setTags} />
            </Field>
            <Field label={t('language')} hint={t('languageHint')}>
              <Select
                value={language}
                onChange={(event) => setLanguage(event.target.value as ContentLanguage)}
              >
                {locales.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Checkbox
              label={t('commentsEnabled')}
              checked={commentsEnabled}
              onChange={setCommentsEnabled}
            />
            <p className="text-xs text-muted/80">{t('commentsEnabledHint')}</p>
          </Section>

          <Section title={t('world')} action={<AiBadge />}>
            <Field label={t('description')} hint={t('descriptionHint')} badge={<AiBadge />}>
              <TextArea
                rows={8}
                value={description}
                placeholder={t('descriptionPlaceholder')}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </Section>

          {/* How it is written, as opposed to what it is about — the narrator
              included, which is why it is no longer beside the world. */}
          <Section title={t('style')} action={<AiBadge />}>
            <p className="text-xs text-muted/80">{t('styleHint')}</p>
            <PlotStyleEditor
              style={style}
              narrator={narrator}
              onChange={setStyle}
              onChangeNarrator={setNarrator}
            />
          </Section>

          <MembersSection
            plotId={id}
            onBusyChange={setMutating}
            members={members}
            onPatch={patchMember}
            onAdd={() => void addMember()}
            onImport={(file) => void importMember(file)}
            onRemove={(memberId) => void removeMember(memberId)}
            onMove={(index, delta) => void move(index, delta)}
            onAvatar={(updated) =>
              setMembers((current) =>
                current.map((member) =>
                  member.id === updated.id ? { ...member, avatarUrl: updated.avatarUrl } : member,
                ),
              )
            }
          />

          <Section
            title={t('intros')}
            action={
              <Button
                size="sm"
                disabled={intros.length >= MAX_INTROS_PER_PLOT}
                onClick={() => setIntros([...intros, ''])}
              >
                {t('introAdd')}
              </Button>
            }
          >
            <p className="text-xs text-muted/80">{t('introsHint')}</p>
            <p className="text-xs text-muted/80">{t('speechProtocolHint')}</p>
            {intros.length === 0 ? <p className="text-sm text-muted">{t('introsEmpty')}</p> : null}
            {intros.map((text, index) => (
              <Field key={index} label={t('introLabel', { index: index + 1 })} badge={<PublicBadge />}>
                <div className="flex gap-2">
                  <TextArea
                    rows={5}
                    value={text}
                    data-testid="plot-intro"
                    maxLength={MAX_INTRO_TEXT_LENGTH}
                    placeholder={t('introTextPlaceholder')}
                    onChange={(event) =>
                      setIntros(intros.map((item, i) => (i === index ? event.target.value : item)))
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={common('remove')}
                    onClick={() => setIntros(intros.filter((_, i) => i !== index))}
                  >
                    ✕
                  </Button>
                </div>
              </Field>
            ))}
          </Section>

          <ProfilesSection profiles={profiles} onChange={setProfiles} />

          <Section title={t('lorebook')} action={<AiBadge />}>
            <p className="text-xs text-muted/80">{t('lorebookHint')}</p>
            <LorebookFileActions
              entries={lorebook}
              fileName={`${name.trim() || plot.name} ${t('lorebook')}`}
              onImport={(imported) => setLorebook((current) => [...current, ...imported])}
            />
            <LorebookEditor entries={lorebook} onChange={setLorebook} />
          </Section>

          <AssetManager plotId={id} />

          {/* The editors carry their own controls, so they sit beside a heading
              rather than inside a Field, whose <label> would swallow the clicks. */}
          <Section title={t('customUi')}>
            <p className="text-xs text-muted/80">{t('customUiHint')}</p>

            <h3 className="text-xs font-medium text-muted">
              {t('displayScripts')}
            </h3>
            <p className="text-xs text-muted/80">{t('displayScriptsHint')}</p>
            <DisplayScriptEditor scripts={scripts} onChange={setScripts} />

            <h3 className="text-xs font-medium text-muted">
              {t('defaultVariables')}
            </h3>
            <p className="text-xs text-muted/80">{t('defaultVariablesHint')}</p>
            <DefaultVariablesEditor variables={variables} onChange={setVariables} />

            <h3 className="text-xs font-medium text-muted">
              {t('componentCode')}
            </h3>
            <p className="text-xs text-muted/80">{t('componentCodeSectionHint')}</p>
            <ComponentCodeEditor
              code={componentCode}
              capabilities={capabilities}
              plotName={name || plot.name}
              defaultVariables={variables}
              onChange={setComponentCode}
              onChangeCapabilities={setCapabilities}
            />
          </Section>
        </div>

        <div className="space-y-6">
          <VisibilitySection plot={plot} onChange={adoptPlot} onBusyChange={setMutating} />
          <ChatList plotId={id} />
          <Button variant="danger" className="w-full" onClick={() => void remove()}>
            {t('deletePlot')}
          </Button>
        </div>
      </div>
    </fieldset>
  );
}

/**
 * The reader profiles the work recommends. Written for readers rather than for
 * the model — the start panel offers them as chips, and a pick is copied into
 * the reader's own personas — so they ride the one Save like every other field
 * of the plot row.
 *
 * A row with no name is dropped by the API's coercion, and the id is minted
 * there too: a new row goes up without one and comes back with one.
 */
function ProfilesSection({
  profiles,
  onChange,
}: {
  profiles: PlotProfile[];
  onChange: (profiles: PlotProfile[]) => void;
}) {
  const t = useTranslations('plot');
  const common = useTranslations('common');

  const patch = (index: number, fields: Partial<PlotProfile>): void =>
    onChange(profiles.map((profile, at) => (at === index ? { ...profile, ...fields } : profile)));

  return (
    <Section
      title={t('profiles')}
      action={
        <span className="text-xs text-muted tabular-nums">
          {t('profileCount', { count: profiles.length, max: MAX_PLOT_PROFILES })}
        </span>
      }
    >
      <p className="text-xs text-muted/80">{t('profilesHint')}</p>

      {profiles.length === 0 ? <p className="text-sm text-muted">{t('profilesEmpty')}</p> : null}

      {profiles.map((profile, index) => (
        <div
          key={profile.id || index}
          data-testid="plot-profile"
          className="space-y-3 rounded-lg border border-line bg-canvas/40 p-3"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Field label={t('profileName')} badge={<PublicBadge />}>
                <TextInput
                  value={profile.name}
                  maxLength={MAX_PLOT_PROFILE_NAME_LENGTH}
                  placeholder={t('profileNamePlaceholder')}
                  onChange={(event) => patch(index, { name: event.target.value })}
                />
              </Field>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="mt-5"
              aria-label={common('removeItem', { item: profile.name || t('profileName') })}
              onClick={() => onChange(profiles.filter((_, at) => at !== index))}
            >
              ✕
            </Button>
          </div>
          <Field label={t('profileDescription')} badge={<PublicBadge />}>
            <TextArea
              rows={3}
              value={profile.description}
              maxLength={MAX_PLOT_PROFILE_DESCRIPTION_LENGTH}
              placeholder={t('profileDescriptionPlaceholder')}
              onChange={(event) => patch(index, { description: event.target.value })}
            />
          </Field>
        </div>
      ))}

      <Button
        disabled={profiles.length >= MAX_PLOT_PROFILES}
        onClick={() => onChange([...profiles, { id: '', name: '', description: '' }])}
      >
        {t('profileAdd')}
      </Button>
    </Section>
  );
}

/** The roster: who is in the work, in the order the prompt names them. */
function MembersSection({
  plotId,
  members,
  onPatch,
  onAdd,
  onImport,
  onRemove,
  onMove,
  onAvatar,
  onBusyChange,
}: {
  onBusyChange: (busy: boolean) => void;
  plotId: string;
  members: PlotMember[];
  onPatch: (id: string, patch: Partial<NormalizedCard>, name?: string) => void;
  onAdd: () => void;
  onImport: (file: File) => void;
  onRemove: (id: string) => void;
  onMove: (index: number, delta: number) => void;
  onAvatar: (member: PlotMember) => void;
}) {
  const t = useTranslations('plot');
  const common = useTranslations('common');
  const fileInput = useRef<HTMLInputElement>(null);
  const full = members.length >= MAX_CHARACTERS_PER_PLOT;

  return (
    <Section
      title={t('members')}
      action={
        <span className="text-xs text-muted tabular-nums">
          {t('memberCount', { count: members.length, max: MAX_CHARACTERS_PER_PLOT })}
        </span>
      }
    >
      <p className="text-xs text-muted/80">{t('membersHint')}</p>

      {members.length === 0 ? <p className="text-sm text-muted">{t('membersEmpty')}</p> : null}

      {members.map((member, index) => (
        <details
          key={member.id}
          data-testid="plot-member"
          className="group rounded-lg border border-line bg-canvas/40 [&[open]]:bg-canvas/70"
        >
          <summary className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
            <Avatar src={member.avatarUrl} name={member.name} className="size-7 text-xs" />
            <span className="min-w-0 flex-1 truncate text-fg">{member.name}</span>
            <span className="text-xs text-muted tabular-nums">{index + 1}</span>
          </summary>

          <div className="space-y-4 border-t border-line px-3 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <MemberAvatarPicker plotId={plotId} member={member} onChange={onAvatar} onBusyChange={onBusyChange} />
              <span className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('memberMoveUp')}
                  disabled={index === 0}
                  onClick={() => onMove(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('memberMoveDown')}
                  disabled={index === members.length - 1}
                  onClick={() => onMove(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={common('removeItem', { item: member.name })}
                  onClick={() => onRemove(member.id)}
                >
                  ✕
                </Button>
              </span>
            </div>

            <Field label={t('memberName')} badge={<PublicBadge />}>
              <TextInput
                value={member.name}
                onChange={(event) => onPatch(member.id, {}, event.target.value)}
              />
            </Field>
            <Field label={t('memberIntro')} hint={t('memberIntroHint')} badge={<PublicBadge />}>
              <TextArea
                rows={2}
                value={member.card.intro ?? ''}
                placeholder={t('memberIntroPlaceholder')}
                onChange={(event) => onPatch(member.id, { intro: event.target.value })}
              />
            </Field>
            <Field label={t('memberDescription')} hint={t('memberDescriptionHint')} badge={<AiBadge />}>
              <TextArea
                rows={6}
                value={member.card.description}
                onChange={(event) => onPatch(member.id, { description: event.target.value })}
              />
            </Field>
            <Field label={t('memberPersonality')} badge={<AiBadge />}>
              <TextArea
                rows={3}
                value={member.card.personality}
                onChange={(event) => onPatch(member.id, { personality: event.target.value })}
              />
            </Field>
            <Field label={t('memberMesExample')} hint={t('memberMesExampleHint')} badge={<AiBadge />}>
              <TextArea
                rows={5}
                value={member.card.mesExample}
                onChange={(event) => onPatch(member.id, { mesExample: event.target.value })}
              />
            </Field>

            {/* Links rather than buttons: the route answers with the file itself,
                built from the saved card — which is what the hint tells the creator. */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted">
                  {t('memberExport')}
                </span>
                {(['json', 'png'] as const).map((format) => (
                  <a
                    key={format}
                    href={`/api/plots/${plotId}/characters/${member.id}/export?format=${format}`}
                    download
                    data-testid={`member-export-${format}`}
                    className={buttonClass('secondary', 'sm')}
                  >
                    {format === 'json' ? t('memberExportJson') : t('memberExportPng')}
                  </a>
                ))}
              </div>
              <p className="text-xs text-muted/80">{t('memberExportHint')}</p>
            </div>
          </div>
        </details>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          data-testid="member-import-input"
          type="file"
          accept=".png,.json,.charx"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onImport(file);
          }}
        />
        <Button disabled={full} onClick={onAdd}>
          {t('memberAdd')}
        </Button>
        <Button disabled={full} title={t('memberImportHint')} onClick={() => fileInput.current?.click()}>
          {t('memberImport')}
        </Button>
      </div>
    </Section>
  );
}

/**
 * A member's picture. The upload answers with the member row alone, so it takes
 * effect at once and leaves the card being written beside it standing — and the
 * preview is cache-busted, since the URL is derived from the member id and a
 * replaced image would otherwise be the browser's old copy.
 */
function MemberAvatarPicker({
  plotId,
  member,
  onChange,
  onBusyChange,
}: {
  onBusyChange: (busy: boolean) => void;
  plotId: string;
  member: PlotMember;
  onChange: (member: PlotMember) => void;
}) {
  const t = useTranslations('plot');
  const toMessage = useErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  async function run(send: () => Promise<PlotMember>): Promise<void> {
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      onChange(await send());
      setVersion((current) => current + 1);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
      onBusyChange(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const path = `/api/plots/${plotId}/characters/${member.id}/avatar`;

  return (
    <div className="flex items-center gap-3">
      <Avatar
        src={member.avatarUrl ? `${member.avatarUrl}?v=${version}` : null}
        name={member.name}
        className="size-14 text-xl"
      />
      <div className="flex flex-col items-start gap-1">
        <input
          ref={fileInput}
          data-testid="avatar-file-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (picked) void run(() => apiUpload<PlotMember>(path, picked));
          }}
        />
        <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
          {busy ? t('avatarUploading') : t('avatarUpload')}
        </Button>
        {member.avatarUrl ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => apiSend<PlotMember>('DELETE', path))}
          >
            {t('avatarRemove')}
          </Button>
        ) : (
          <span className="text-xs text-muted/80">{t('avatarHint')}</span>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}

/**
 * The work's cover. It carries its own controls, so it sits beside a heading
 * rather than inside a `Field`, whose <label> would swallow the clicks — and the
 * preview is cache-busted, since the URL is derived from the plot id and a
 * replaced image would otherwise be the browser's old copy.
 */
function CoverPicker({
  plot,
  onChange,
  onBusyChange,
}: {
  onBusyChange: (busy: boolean) => void;
  plot: PlotDetail;
  onChange: (plot: PlotDetail) => void;
}) {
  const t = useTranslations('plot');
  const toMessage = useErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  async function run(send: () => Promise<PlotDetail>): Promise<void> {
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      onChange(await send());
      setVersion((current) => current + 1);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
      onBusyChange(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div className="space-y-1.5">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted">{t('cover')}</span>
        <PublicBadge />
      </span>
      {plot.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${plot.coverUrl}?v=${version}`}
          alt=""
          data-testid="plot-cover"
          className="aspect-[16/9] w-full rounded-lg border border-line object-cover"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          data-testid="cover-file-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (picked) {
              void run(() => apiUpload<PlotDetail>(`/api/plots/${plot.id}/cover`, picked));
            }
          }}
        />
        <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
          {busy ? t('coverUploading') : t('coverUpload')}
        </Button>
        {plot.coverUrl ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(() => apiSend<PlotDetail>('DELETE', `/api/plots/${plot.id}/cover`))
            }
          >
            {t('coverRemove')}
          </Button>
        ) : null}
      </div>
      <span className="block text-xs text-muted/80">{t('coverHint')}</span>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/**
 * Publish toggle and the audience that goes with it. Publishing validates the
 * *stored* plot, so the panel says so rather than silently saving first — and
 * only the plot row is refreshed, which leaves unsaved edits alone.
 */
function VisibilitySection({
  plot,
  onChange,
  onBusyChange,
}: {
  onBusyChange: (busy: boolean) => void;
  plot: PlotDetail;
  onChange: (plot: PlotDetail) => void;
}) {
  const t = useTranslations('plot');
  const toMessage = useErrorMessage();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // All-ages is the only level a publish may declare until age verification
  // exists, even for a plot stored as adult before that.
  const [safetyLevel, setSafetyLevel] = useState<SafetyLevel>('all');
  const published = plot.visibility === 'public';
  // A plot stored as adult is published but not listed anywhere, so say so
  // wherever the owner can see it.
  const gated = published && plot.safetyLevel === 'adult';

  async function toggle(): Promise<void> {
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      onChange(
        await apiSend<PlotDetail>('POST', `/api/plots/${plot.id}/publish`, {
          publish: !published,
          safetyLevel,
        }),
      );
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <Section title={t('visibility')}>
      <p className="text-sm text-muted">{published ? t('visibilityPublic') : t('visibilityPrivate')}</p>
      <Field label={t('safetyLevel')} hint={t('safetyLevelHint')}>
        <Select
          disabled={busy}
          data-testid="safety-select"
          value={safetyLevel}
          onChange={(event) => setSafetyLevel(event.target.value as SafetyLevel)}
        >
          <option value="all">{t('safetyAll')}</option>
        </Select>
      </Field>
      {gated ? (
        <p data-testid="adult-gate-notice" className="text-xs text-link">
          {t('safetyAdultPending')}
        </p>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <Button
        variant={published ? 'secondary' : 'primary'}
        className="w-full"
        busy={busy}
        onClick={() => void toggle()}
      >
        {published ? t('unpublish') : t('publish')}
      </Button>
      {published ? null : <p className="text-xs text-muted/80">{t('publishHint')}</p>}
      <Link
        href={`/p/${plot.id}`}
        className="block text-center text-xs text-muted transition-colors hover:text-fg"
      >
        {t('viewPublic')}
      </Link>
    </Section>
  );
}

/** The reader's own conversations with this work. */
function ChatList({ plotId }: { plotId: string }) {
  const t = useTranslations('plot');
  const common = useTranslations('common');
  const format = useFormatter();
  const toMessage = useErrorMessage();

  const [chats, setChats] = useState<Chat[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet<Chat[]>(`/api/chats?plotId=${plotId}`).then(setChats, (caught: unknown) =>
      setError(toMessage(caught)),
    );
  }, [plotId, toMessage]);

  async function remove(id: string): Promise<void> {
    if (!window.confirm(common('confirmDelete'))) return;
    try {
      await apiDelete(`/api/chats/${id}`);
      setChats((current) => (current ?? []).filter((chat) => chat.id !== id));
    } catch (caught) {
      setError(toMessage(caught));
    }
  }

  return (
    <Section title={t('chats')}>
      <ErrorText>{error}</ErrorText>
      {chats === null ? null : chats.length === 0 ? (
        <p className="text-sm text-muted">{t('chatsEmpty')}</p>
      ) : (
        <ul className="space-y-1">
          {chats.map((chat) => (
            <li key={chat.id} className="group flex items-center gap-2">
              <Link
                href={`/chats/${chat.id}`}
                className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-raised"
              >
                <span className="block truncate">{chat.title || chat.id}</span>
                <span className="block text-xs text-muted">
                  {format.dateTime(new Date(chat.updatedAt), { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </Link>
              <Button
                variant="ghost"
                size="sm"
                aria-label={common('delete')}
                className="opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => void remove(chat.id)}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

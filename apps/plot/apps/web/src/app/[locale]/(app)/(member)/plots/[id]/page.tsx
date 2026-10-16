'use client';

import { emotionModeOf, extensionsWithEmotionMode } from '@shizue/core/emotion';
import { coerceGroupSettings, DEFAULT_GROUP_SETTINGS, type GroupSettings } from '@shizue/core/group';
import { carriesScripts } from '@shizue/core/triggers';
import { useFormatter, useTranslations } from 'next-intl';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { AssetManager } from '@/components/AssetManager';
import { AiBadge, PublicBadge } from '@/components/AudienceBadge';
import { Avatar } from '@/components/Avatar';
import { ImportedCardDetails, ImportWarnings, RealmImportForm, RightsConfirmation } from '@/components/CardImport';
import { ComponentCodeEditor } from '@/components/ComponentCodeEditor';
import { GroupTurnsEditor } from '@/components/GroupTurnsEditor';
import { DefaultVariablesEditor, DisplayScriptEditor } from '@/components/DisplayScriptEditor';
import { LorebookEditor } from '@/components/LorebookEditor';
import { LorebookFileActions } from '@/components/LorebookFileActions';
import { ModuleManager } from '@/components/ModuleManager';
import { OpeningEditor } from '@/components/OpeningEditor';
import { PlotStyleEditor } from '@/components/PlotStyleEditor';
import { TagInput } from '@/components/TagInput';
import {
  Badge,
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
import { readImportWarnings, takeImportWarnings, type ImportWarning } from '@/lib/importWarnings';
import { loreBudget } from '@/lib/loreBudget';
import { checkCardSize, downloadRealmCard, isRestrictiveLicense } from '@/lib/realm';
import {
  MAX_CHARACTERS_PER_PLOT,
  MAX_INTRO_LENGTH,
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

/** A RisuAI card's extension block (`extensions.risuai`), where the card has one. */
const risuExtensionOf = (card: NormalizedCard): Record<string, unknown> | undefined => {
  const risu = card.extensions?.['risuai'];
  return risu !== null && typeof risu === 'object' && !Array.isArray(risu) ? (risu as Record<string, unknown>) : undefined;
};

/** The fields the roster editor writes — the card's, and the member's 대화량; the rest of the card stays on the server. */
const memberFields = (member: PlotMember): string =>
  JSON.stringify([
    member.name,
    member.talkativeness,
    member.card.intro ?? '',
    member.card.description,
    member.card.personality,
    member.card.mesExample,
    member.card.systemPrompt,
    member.card.postHistoryInstructions,
    member.card.lorebook,
    member.card.loreSettings,
    emotionModeOf(member.card),
    risuExtensionOf(member.card)?.['utilityBot'] === true,
  ]);

/**
 * What Save sends for a member: the fields `memberFields` tracks and no more.
 * The server lays them over the card it holds, so the rest — the original card,
 * a RisuAI card's extensions with its scripts — never travels back, and the two
 * RisuAI settings go as values rather than as the extension they live in.
 */
const memberSave = (member: PlotMember) => ({
  name: member.name.trim() || member.card.name,
  talkativeness: member.talkativeness,
  card: {
    intro: member.card.intro ?? '',
    description: member.card.description,
    personality: member.card.personality,
    mesExample: member.card.mesExample,
    systemPrompt: member.card.systemPrompt,
    postHistoryInstructions: member.card.postHistoryInstructions,
    lorebook: member.card.lorebook,
    loreSettings: member.card.loreSettings,
  },
  emotionMode: emotionModeOf(member.card),
  utilityBot: risuExtensionOf(member.card)?.['utilityBot'] === true,
});

/** The card files a member exports to, and their labels. Only CharX carries the plot's images. */
const EXPORT_FORMATS = [
  ['json', 'memberExportJson'],
  ['png', 'memberExportPng'],
  ['charx', 'memberExportCharx'],
] as const;

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
  /** How a round of the work's members is picked; only offered with two or more of them. */
  const [groupSettings, setGroupSettings] = useState<GroupSettings>(DEFAULT_GROUP_SETTINGS);
  const [lorebook, setLorebook] = useState<LoreEntry[]>([]);
  const [scripts, setScripts] = useState<DisplayScript[]>([]);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [css, setCss] = useState('');
  /** Each member's own stylesheet in a work of several, by member id (`PlotCustomUi.memberCss`). */
  const [memberCss, setMemberCss] = useState<Record<string, string>>({});
  /**
   * The work's background as the editor holds it: undefined until the creator
   * touches it on a plot from before the field, which keeps drawing its card's
   * (`PlotDetail.backgroundHtml`) — the field shows that, and only an edit makes
   * it the work's own.
   */
  const [background, setBackground] = useState<string | undefined>(undefined);
  /** The default variables a companion's card brought that the work kept its own value for. */
  const [variableNotice, setVariableNotice] = useState('');
  /** What the last card import left behind — the plot's own, handed over from the list, or a member's. */
  const [importWarnings, setImportWarnings] = useState<ImportWarning[]>([]);
  const [componentCode, setComponentCode] = useState('');
  const [capabilities, setCapabilities] = useState<ComponentCapability[]>([]);
  /** Bumped when a module brought or took pictures, so the asset list reads them again. */
  const [assetRevision, setAssetRevision] = useState(0);
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
    setGroupSettings(coerceGroupSettings(detail.groupSettings));
    setLorebook(detail.lorebook);
    setScripts(detail.customUi?.displayScripts ?? []);
    setVariables(detail.customUi?.defaultVariables ?? {});
    setCss(detail.customUi?.css ?? '');
    setMemberCss(detail.customUi?.memberCss ?? {});
    setBackground(detail.customUi?.backgroundHtml);
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

  // The import that made this plot, a moment ago, said what it left behind.
  // Read once: a second run of the effect finds nothing and keeps what the first found.
  useEffect(() => {
    const taken = takeImportWarnings(id);
    if (taken.length > 0) setImportWarnings(taken);
  }, [id]);

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
        await apiSend<PlotMember>('PATCH', `/api/plots/${id}/characters/${member.id}`, memberSave(member));
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
          groupSettings,
          lorebook,
          customUi: {
            displayScripts: scripts,
            css,
            defaultVariables: variables,
            componentCode,
            componentCapabilities: capabilities,
            // A sheet left empty is no sheet, as the server keeps it.
            memberCss: Object.fromEntries(Object.entries(memberCss).filter(([, sheet]) => sheet.trim() !== '')),
            ...(background !== undefined ? { backgroundHtml: background } : {}),
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

  /**
   * A card as one more member — a picked file, or a RisuRealm page this browser
   * downloads first (`downloadRealmCard`). Into a public plot the import itself
   * publishes the member, so the owner's word rides along and the server stamps
   * it; the panel's date follows without a re-read.
   */
  async function importMember(source: File | string, rightsConfirmed: boolean): Promise<boolean> {
    if (locked) return false;
    setMutating(true);
    setError('');
    try {
      let file: File;
      const fields: Record<string, string> = {};
      if (typeof source === 'string') {
        const realm = await downloadRealmCard(source);
        file = realm.file;
        fields['sourceUrl'] = realm.sourceUrl;
      } else {
        file = checkCardSize(source);
      }
      if (rightsConfirmed) fields['rightsConfirmed'] = 'true';
      const created = await apiUpload<PlotMember & { variableConflicts?: string[]; importWarnings?: unknown }>(
        `/api/plots/${id}/characters/import`,
        file,
        fields,
      );
      setMembers((current) => [...current, created]);
      setSaved((current) => new Map(current).set(created.id, memberFields(created)));
      // The card brought its own custom UI to the work (its scripts, its stylesheet,
      // its default variables, and the background the work now keeps). The editor
      // takes that up beside whatever is being written here, or the next save would
      // put the old lists back over it. A failed read does not unmake the import.
      await apiGet<PlotDetail>(`/api/plots/${id}`).then(
        (detail) => {
          const lifted = detail.customUi ?? {};
          const brought = (lifted.displayScripts ?? []).filter((script) => script.memberId === created.id);
          if (brought.length > 0) setScripts((current) => [...current, ...brought]);
          const sheet = lifted.memberCss?.[created.id];
          if (sheet) setMemberCss((current) => ({ ...current, [created.id]: sheet }));
          // The web fonts its templates imported, which the import brought into the
          // work's stylesheet — at the end of it, so a sheet that only grew is taken
          // up; one being edited here keeps the edit.
          setCss((current) => {
            const grown = lifted.css ?? '';
            return grown.length > current.length && grown.startsWith(current) ? grown : current;
          });
          setVariables((current) => {
            const next = Object.assign(Object.create(null) as Record<string, string>, current);
            for (const [key, value] of Object.entries(lifted.defaultVariables ?? {})) {
              if (!Object.hasOwn(next, key)) next[key] = value;
            }
            return next;
          });
          setBackground((current) => current ?? lifted.backgroundHtml);
          setPlot((current) => current && { ...current, ...(detail.backgroundHtml !== undefined ? { backgroundHtml: detail.backgroundHtml } : {}) });
        },
        () => undefined,
      );
      setImportWarnings(readImportWarnings(created.importWarnings));
      setVariableNotice(
        created.variableConflicts?.length
          ? t('memberImportVariableConflicts', { name: created.name, names: created.variableConflicts.join(', ') })
          : '',
      );
      if (rightsConfirmed) {
        setPlot((current) => current && { ...current, rightsConfirmedAt: new Date().toISOString() });
      }
      // Joining a cast, the card's group-only greetings became openings of the
      // plot on the server. The editor takes them up after whatever is being
      // written here, or the next save would put the old list back over them.
      // A failed read does not unmake the import, which has landed.
      if (members.length > 0 && created.card.groupOnlyGreetings?.length) {
        await apiGet<PlotDetail>(`/api/plots/${id}`).then(
          (detail) => {
            const added = detail.intros.slice(plot?.intros.length ?? 0);
            setIntros((current) => [...current, ...added]);
            setPlot((current) => current && { ...current, intros: detail.intros });
          },
          () => undefined,
        );
      }
      return true;
    } catch (caught) {
      setError(toMessage(caught));
      return false;
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
      // What came with the member went with it on the server; the editor follows.
      setScripts((current) => current.filter((script) => script.memberId !== memberId));
      setMemberCss(({ [memberId]: _gone, ...rest }) => rest);
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
        {variableNotice ? (
          <p role="status" data-testid="variable-conflicts" className="text-xs text-link">
            {variableNotice}
          </p>
        ) : null}
        <ImportWarnings warnings={importWarnings} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title={t('profile')}>
            {/* First, because it is the first thing a reader sees of the work. */}
            <Field label={t('intro')} hint={t('introHint')} badge={<PublicBadge />}>
              <TextArea
                rows={3}
                value={intro}
                maxLength={MAX_INTRO_LENGTH}
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
            <p className="text-xs text-muted">{t('commentsEnabledHint')}</p>
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
            <p className="text-xs text-muted">{t('styleHint')}</p>
            <PlotStyleEditor
              style={style}
              narrator={narrator}
              onChange={setStyle}
              onChangeNarrator={setNarrator}
            />
          </Section>

          <MembersSection
            plotId={id}
            published={plot.visibility === 'public'}
            plotLoreConstantTokens={plot.plotLoreConstantTokens}
            onBusyChange={setMutating}
            members={members}
            onPatch={patchMember}
            onAdd={() => void addMember()}
            onImport={importMember}
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

          {/* A work of one member answers as it always has, so there is nothing
              to set until a second one joins. */}
          {members.length >= 2 ? (
            <Section title={t('groupFlow')}>
              <GroupTurnsEditor
                settings={groupSettings}
                members={members}
                onChange={setGroupSettings}
                onTalkativeness={(memberId, talkativeness) =>
                  setMembers((current) =>
                    current.map((member) => (member.id === memberId ? { ...member, talkativeness } : member)),
                  )
                }
              />
            </Section>
          ) : null}

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
            <p className="text-xs text-muted">{t('introsHint')}</p>
            <p className="text-xs text-muted">{t('speechProtocolHint')}</p>
            <p className="text-xs text-muted">{t('sceneTitleHint')}</p>
            {intros.length === 0 ? <p className="text-sm text-muted">{t('introsEmpty')}</p> : null}
            {intros.map((text, index) => (
              <OpeningEditor
                key={index}
                index={index}
                value={text}
                maxLength={MAX_INTRO_TEXT_LENGTH}
                onChange={(value) => setIntros(intros.map((item, i) => (i === index ? value : item)))}
                onRemove={() => setIntros(intros.filter((_, i) => i !== index))}
              />
            ))}
          </Section>

          <ProfilesSection profiles={profiles} onChange={setProfiles} />

          <Section title={t('lorebook')} action={<AiBadge />}>
            <p className="text-xs text-muted">{t('lorebookHint')}</p>
            <LoreBudgetNote plotTokens={plot.plotLoreConstantTokens} members={members} />
            <p className="text-xs text-muted">{t('loreBudgetHint')}</p>
            {members[0] ? <LoreBudgetInput member={members[0]} onPatch={patchMember} /> : null}
            <LorebookFileActions
              entries={lorebook}
              fileName={`${name.trim() || plot.name} ${t('lorebook')}`}
              onImport={(imported) => setLorebook((current) => [...current, ...imported])}
            />
            <LorebookEditor entries={lorebook} onChange={setLorebook} />
          </Section>

          <AssetManager plotId={id} revision={assetRevision} />

          {/* The editors carry their own controls, so they sit beside a heading
              rather than inside a Field, whose <label> would swallow the clicks. */}
          <Section title={t('customUi')}>
            <p className="text-xs text-muted">{t('customUiHint')}</p>

            {/* RisuAI modules land at once, outside the Save: only the plot's
                list of them is taken up, so what is being written here stays. */}
            <ModuleManager
              plotId={id}
              modules={plot.modules ?? []}
              published={plot.visibility === 'public'}
              disabled={locked}
              onChange={(detail) => {
                setPlot(
                  (current) =>
                    current && {
                      ...current,
                      modules: detail.modules,
                      ...(detail.rightsConfirmedAt ? { rightsConfirmedAt: detail.rightsConfirmedAt } : {}),
                    },
                );
                setAssetRevision((current) => current + 1);
              }}
            />

            <h3 className="text-xs font-medium text-muted">
              {t('displayScripts')}
            </h3>
            <p className="text-xs text-muted">{t('displayScriptsHint')}</p>
            <DisplayScriptEditor scripts={scripts} members={members} onChange={setScripts} />

            <Field label={t('creatorCss')} hint={t('creatorCssHint')}>
              <TextArea
                rows={6}
                spellCheck={false}
                className="font-mono text-xs"
                value={css}
                onChange={(event) => setCss(event.target.value)}
              />
            </Field>

            {/* A member's own stylesheet, as its card brought it or as the creator
                started one: for its messages. */}
            {members.length >= 2
              ? members
                  .filter((member) => memberCss[member.id] !== undefined)
                  .map((member) => (
                    <Field key={member.id} label={t('memberCss', { name: member.name })} hint={t('memberCssHint')}>
                      <TextArea
                        rows={4}
                        spellCheck={false}
                        data-testid="member-css"
                        className="font-mono text-xs"
                        value={memberCss[member.id]}
                        onChange={(event) => setMemberCss((current) => ({ ...current, [member.id]: event.target.value }))}
                      />
                    </Field>
                  ))
              : null}
            {members.length >= 2 && members.some((member) => memberCss[member.id] === undefined) ? (
              <div className="flex flex-wrap gap-2">
                {members
                  .filter((member) => memberCss[member.id] === undefined)
                  .map((member) => (
                    <Button
                      key={member.id}
                      size="sm"
                      variant="ghost"
                      data-testid="member-css-add"
                      onClick={() => setMemberCss((current) => ({ ...current, [member.id]: '' }))}
                    >
                      {t('memberCssAdd', { name: member.name })}
                    </Button>
                  ))}
              </div>
            ) : null}

            <Field label={t('workBackground')} hint={t('workBackgroundHint')}>
              <TextArea
                rows={4}
                spellCheck={false}
                data-testid="work-background"
                className="font-mono text-xs"
                value={background ?? plot.backgroundHtml ?? ''}
                onChange={(event) => setBackground(event.target.value)}
              />
            </Field>

            <h3 className="text-xs font-medium text-muted">
              {t('defaultVariables')}
            </h3>
            <p className="text-xs text-muted">{t('defaultVariablesHint')}</p>
            <DefaultVariablesEditor variables={variables} onChange={setVariables} />

            <h3 className="text-xs font-medium text-muted">
              {t('componentCode')}
            </h3>
            <p className="text-xs text-muted">{t('componentCodeSectionHint')}</p>
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
          <VisibilitySection
            plot={plot}
            members={members}
            onChange={adoptPlot}
            onBusyChange={setMutating}
          />
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
      <p className="text-xs text-muted">{t('profilesHint')}</p>

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

/**
 * The roster: who is in the work, in the order the prompt names them. A card
 * imported into a plot that is already public reaches readers at once, so there
 * the imports wait for the owner's word — asked again for every card.
 */
function MembersSection({
  plotId,
  published,
  plotLoreConstantTokens,
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
  published: boolean;
  /** The plot lorebook's share of the budget the card lorebooks are counted against. */
  plotLoreConstantTokens: number;
  members: PlotMember[];
  onPatch: (id: string, patch: Partial<NormalizedCard>, name?: string) => void;
  onAdd: () => void;
  /** A file or a RisuRealm page; resolves true once the member is in. */
  onImport: (source: File | string, rightsConfirmed: boolean) => Promise<boolean>;
  onRemove: (id: string) => void;
  onMove: (index: number, delta: number) => void;
  onAvatar: (member: PlotMember) => void;
}) {
  const t = useTranslations('plot');
  const common = useTranslations('common');
  const rights = useTranslations('rights');
  const cardImport = useTranslations('cardImport');
  const fileInput = useRef<HTMLInputElement>(null);
  const full = members.length >= MAX_CHARACTERS_PER_PLOT;
  const [realmOpen, setRealmOpen] = useState(false);
  const [importRights, setImportRights] = useState(false);
  const importBlocked = full || (published && !importRights);

  async function importCard(source: File | string): Promise<boolean> {
    const done = await onImport(source, published && importRights);
    if (done) setImportRights(false);
    return done;
  }

  return (
    <Section
      title={t('members')}
      action={
        <span className="text-xs text-muted tabular-nums">
          {t('memberCount', { count: members.length, max: MAX_CHARACTERS_PER_PLOT })}
        </span>
      }
    >
      <p className="text-xs text-muted">{t('membersHint')}</p>

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
            {member.importedFrom ? <Badge>{rights('importedBadge')}</Badge> : null}
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

            <ImportedCardDetails member={member} />

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

            {/* The two overrides are read from the first member alone, so on any
                other row a written one is said to be idle rather than left to
                look as though it were in every prompt. */}
            <Field label={t('memberSystemPrompt')} hint={t('memberSystemPromptHint')} badge={<AiBadge />}>
              <TextArea
                rows={4}
                value={member.card.systemPrompt}
                onChange={(event) => onPatch(member.id, { systemPrompt: event.target.value })}
              />
            </Field>
            {index > 0 && member.card.systemPrompt.trim() ? (
              <p className="text-xs text-link">{t('memberFirstOnlyIdle', { first: members[0]!.name })}</p>
            ) : null}
            <Field label={t('memberPostHistory')} hint={t('memberPostHistoryHint')} badge={<AiBadge />}>
              <TextArea
                rows={4}
                value={member.card.postHistoryInstructions}
                onChange={(event) => onPatch(member.id, { postHistoryInstructions: event.target.value })}
              />
            </Field>
            {index > 0 && member.card.postHistoryInstructions.trim() ? (
              <p className="text-xs text-link">{t('memberFirstOnlyIdle', { first: members[0]!.name })}</p>
            ) : null}
            <UtilityBotToggle member={member} onPatch={onPatch} />

            {/* Beside a heading rather than inside a Field, like the plot's own
                lorebook: the editor's buttons and checkboxes are its own. */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-xs font-medium text-muted">{t('memberLorebook')}</h3>
                <AiBadge />
              </div>
              <p className="text-xs text-muted">{t('memberLorebookHint')}</p>
              <LoreBudgetNote plotTokens={plotLoreConstantTokens} members={members} />
              <LorebookFileActions
                entries={member.card.lorebook}
                fileName={`${member.name} ${t('memberLorebook')}`}
                onImport={(imported) =>
                  onPatch(member.id, { lorebook: [...member.card.lorebook, ...imported] })
                }
              />
              <LorebookEditor
                entries={member.card.lorebook}
                onChange={(lorebook) => onPatch(member.id, { lorebook })}
              />
            </div>

            {/* Only for a card that brought expression pictures: how RisuAI's
                emotion screen shows them, written where RisuAI keeps it. */}
            {member.card.emotionImages?.length ? (
              <Field
                label={t('memberEmotion')}
                hint={t('memberEmotionHint', { count: member.card.emotionImages.length })}
              >
                <Select
                  data-testid="member-emotion-mode"
                  value={emotionModeOf(member.card) ?? 'off'}
                  onChange={(event) => {
                    const value = event.target.value;
                    onPatch(member.id, {
                      extensions: extensionsWithEmotionMode(
                        member.card.extensions,
                        value === 'panel' || value === 'inlay' ? value : null,
                      ),
                    });
                  }}
                >
                  {(['off', 'panel', 'inlay'] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(`memberEmotionModes.${value}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            {/* Links rather than buttons: the route answers with the file itself,
                built from the saved card — which is what the hint tells the creator. */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted">
                  {t('memberExport')}
                </span>
                {EXPORT_FORMATS.map(([format, label]) => (
                  <a
                    key={format}
                    href={`/api/plots/${plotId}/characters/${member.id}/export?format=${format}`}
                    download
                    data-testid={`member-export-${format}`}
                    className={buttonClass('secondary', 'sm')}
                  >
                    {t(label)}
                  </a>
                ))}
              </div>
              <p className="text-xs text-muted">{t('memberExportHint')}</p>
            </div>
          </div>
        </details>
      ))}

      {published ? (
        <RightsConfirmation
          notice={rights('importPublicNotice')}
          label={rights('confirmImport')}
          checked={importRights}
          onChange={setImportRights}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          data-testid="member-import-input"
          type="file"
          accept=".png,.json,.charx,.jpg,.jpeg"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importCard(file);
          }}
        />
        <Button disabled={full} onClick={onAdd}>
          {t('memberAdd')}
        </Button>
        <Button disabled={importBlocked} title={t('memberImportHint')} onClick={() => fileInput.current?.click()}>
          {t('memberImport')}
        </Button>
        <Button
          data-testid="member-realm-open"
          disabled={full}
          aria-expanded={realmOpen}
          onClick={() => setRealmOpen((open) => !open)}
        >
          {cardImport('realmAdd')}
        </Button>
      </div>
      {realmOpen ? <RealmImportForm disabled={importBlocked} onSubmit={importCard} /> : null}
    </Section>
  );
}

/**
 * The one budget the plot and card lorebooks share, beside each of them. The
 * always-on entries are the part a creator can see going wrong: they are in
 * every prompt whatever the conversation says, and the budget fills from the
 * highest insertion order down, skipping what no longer fits — so once they
 * alone are over, the lower-ordered entries are cut, keyword entries and
 * always-on ones alike. The
 * server counts them from what is saved, so an edit shows here after the next Save.
 */
function LoreBudgetNote({ plotTokens, members }: { plotTokens: number; members: PlotMember[] }) {
  const t = useTranslations('plot');
  const { constantTokens, budget, automatic, share, over } = loreBudget(plotTokens, members);

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted tabular-nums">
        {automatic
          ? t('loreBudgetUsageAuto', { constant: constantTokens, budget, share })
          : t('loreBudgetUsage', { constant: constantTokens, budget })}
      </p>
      {over ? <p className="text-xs text-danger">{t('loreBudgetOver')}</p> : null}
    </div>
  );
}

/**
 * The book's budget, which is the first member's card setting. Emptied, it goes
 * back to absent — automatic — rather than to the 0 an empty number input
 * parses to, which would be a book that never says anything.
 */
function LoreBudgetInput({
  member,
  onPatch,
}: {
  member: PlotMember;
  onPatch: (id: string, patch: Partial<NormalizedCard>) => void;
}) {
  const t = useTranslations('plot');
  const { tokenBudget, ...rest } = member.card.loreSettings;

  return (
    <div className="max-w-xs">
      <Field label={t('loreBudget')} hint={t('loreBudgetInputHint', { first: member.name })}>
        <TextInput
          type="number"
          min={1}
          placeholder={t('loreBudgetAuto')}
          value={tokenBudget ?? ''}
          onChange={(event) => {
            const raw = event.target.value;
            onPatch(member.id, {
              loreSettings: raw.trim() && Number(raw) > 0 ? { ...rest, tokenBudget: Number(raw) } : rest,
            });
          }}
        />
      </Field>
    </div>
  );
}

/**
 * RisuAI's utility-bot setting (`extensions.risuai.utilityBot`), which an
 * imported card keeps in its extensions and the prompt reads there. A quiet
 * switch: only a RisuAI card — one that carries the extension — shows it, and
 * it writes the extension back so the card still round-trips.
 */
function UtilityBotToggle({
  member,
  onPatch,
}: {
  member: PlotMember;
  onPatch: (id: string, patch: Partial<NormalizedCard>) => void;
}) {
  const t = useTranslations('plot');
  const risu = risuExtensionOf(member.card);
  if (!risu) return null;
  const on = risu['utilityBot'] === true;

  return (
    <div className="space-y-1" data-testid="utility-bot">
      <Checkbox
        label={t('memberUtilityBot')}
        checked={on}
        onChange={(checked) =>
          onPatch(member.id, { extensions: { ...member.card.extensions, risuai: { ...risu, utilityBot: checked } } })
        }
      />
      <p className="text-xs text-muted">{t('memberUtilityBotHint')}</p>
    </div>
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
          <span className="text-xs text-muted">{t('avatarHint')}</span>
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
          className="aspect-[2/3] w-32 rounded-lg border border-line object-cover sm:w-40"
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
      <span className="block text-xs text-muted">{t('coverHint')}</span>
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
  members,
  onChange,
  onBusyChange,
}: {
  onBusyChange: (busy: boolean) => void;
  plot: PlotDetail;
  /** The roster as the page holds it, which a member imported a moment ago is already in. */
  members: PlotMember[];
  onChange: (plot: PlotDetail) => void;
}) {
  const t = useTranslations('plot');
  const rights = useTranslations('rights');
  const format = useFormatter();
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
  // Imported characters are somebody's work until the owner says otherwise, and
  // nothing here can tell whose: publishing them waits for the owner's word,
  // asked again for every publish.
  const imported = members.filter((member) => member.importedFrom);
  const restricted = imported
    .filter((member) => isRestrictiveLicense(member.license))
    .map((member) => member.name);
  const needsRights = !published && imported.length > 0;
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  // A RisuAI card's triggers and regex scripts run in the reader's browser, so
  // readers receive them — and the card text they read — once the plot is public.
  // A work's modules run theirs in every member's place.
  const scripted = members.some((member) => carriesScripts(member.card)) || (plot.modules ?? []).some((module) => module.scripts);

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
          ...(needsRights ? { rightsConfirmed } : {}),
        }),
      );
      setRightsConfirmed(false);
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
      {scripted ? (
        <p data-testid="scripts-publish-notice" className="text-xs text-muted">
          {t('scriptsPublishNotice')}
        </p>
      ) : null}
      {needsRights ? (
        <RightsConfirmation
          notice={rights('publishNotice', { count: imported.length })}
          label={rights('confirmPublish')}
          restricted={restricted}
          checked={rightsConfirmed}
          onChange={setRightsConfirmed}
        />
      ) : null}
      <ErrorText>{error}</ErrorText>
      <Button
        variant={published ? 'secondary' : 'primary'}
        className="w-full"
        busy={busy}
        disabled={needsRights && !rightsConfirmed}
        onClick={() => void toggle()}
      >
        {published ? t('unpublish') : t('publish')}
      </Button>
      {published ? null : <p className="text-xs text-muted">{t('publishHint')}</p>}
      {published && imported.length > 0 && plot.rightsConfirmedAt ? (
        <p className="text-xs text-muted">
          {rights('confirmedAt', {
            date: format.dateTime(new Date(plot.rightsConfirmedAt), { dateStyle: 'medium' }),
          })}
        </p>
      ) : null}
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

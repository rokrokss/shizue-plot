'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { CreatorTabs } from '@/components/CreatorTabs';
import { Button, ErrorText, Field, Section, Spinner, TextArea, TextInput } from '@/components/ui';
import { apiDelete, apiGet, apiSend } from '@/lib/api';
import { groupNotes } from '@/lib/notes';
import { MAX_NOTE_LENGTH, type UserNote } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';

/**
 * Reusable author's notes. They live on the account and are attached to a chat
 * from its notes panel; this page only creates, edits and deletes them.
 */
export default function NotesPage() {
  const t = useTranslations('notes');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();
  useDocumentTitle(t('title'));

  const [notes, setNotes] = useState<UserNote[] | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [groupName, setGroupName] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Set<string>>(() => new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setNotes(await apiGet<UserNote[]>('/api/notes'));
    } catch (caught) {
      setError(toMessage(caught));
    }
  }, [toMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    if (busy || !content.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await apiSend<UserNote>('POST', '/api/notes', {
        title: title.trim(),
        groupName: groupName.trim(),
        content,
      });
      setNotes((current) => [...(current ?? []), created]);
      setTitle('');
      setContent('');
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (deleting.has(id) || !window.confirm(common('confirmDelete'))) return;
    setDeleting((current) => new Set(current).add(id));
    try {
      await apiDelete(`/api/notes/${id}`);
      setNotes((current) => (current ?? []).filter((note) => note.id !== id));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setDeleting((current) => { const next = new Set(current); next.delete(id); return next; });
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-10">
      <div className="mb-6">
        <CreatorTabs />
      </div>
      <h1 className="title2 sm:title1">{t('title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('subtitle')}</p>

      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      <div className="mt-6 space-y-4">
        <Section title={t('new')} busy={busy}>
          <Field label={t('noteTitle')}>
            <TextInput
              value={title}
              placeholder={t('noteTitlePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label={t('group')} hint={t('groupHint')}>
            <TextInput
              value={groupName}
              placeholder={t('groupPlaceholder')}
              onChange={(event) => setGroupName(event.target.value)}
            />
          </Field>
          <Field label={t('content')}>
            <TextArea
              rows={4}
              value={content}
              maxLength={MAX_NOTE_LENGTH}
              placeholder={t('contentPlaceholder')}
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            busy={busy}
            disabled={!content.trim()}
            onClick={() => void create()}
          >
            {t('create')}
          </Button>
        </Section>

        {notes === null ? (
          <div className="flex justify-center py-10">
            <Spinner label={common('loading')} />
          </div>
        ) : notes.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t('empty')}</p>
        ) : (
          groupNotes(notes).map((group) => (
            <section key={group.name} className="space-y-3">
              <button
                type="button"
                aria-expanded={!collapsed.includes(group.name)}
                disabled={group.notes.some((note) => savingIds.has(note.id) || deleting.has(note.id))}
                onClick={() =>
                  setCollapsed((current) =>
                    current.includes(group.name)
                      ? current.filter((name) => name !== group.name)
                      : [...current, group.name],
                  )
                }
                className="flex w-full items-center gap-2 rounded-lg text-sm font-medium text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {/* `aria-expanded` already says which way it is turned. */}
                <span aria-hidden>{collapsed.includes(group.name) ? '▸' : '▾'}</span>
                <span>{group.name || t('ungrouped')}</span>
                <span className="text-xs text-muted/70">{group.notes.length}</span>
              </button>

              {collapsed.includes(group.name)
                ? null
                : group.notes.map((note) => (
                    <NoteCard
                      key={note.id}
                      note={note}
                      deleting={deleting.has(note.id)}
                      onBusyChange={(pending) => setSavingIds((current) => {
                        const next = new Set(current);
                        if (pending) next.add(note.id); else next.delete(note.id);
                        return next;
                      })}
                      onSaved={(saved) =>
                        setNotes((current) =>
                          (current ?? []).map((item) => (item.id === saved.id ? saved : item)),
                        )
                      }
                      onDelete={() => void remove(note.id)}
                      onError={setError}
                    />
                  ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function NoteCard({
  note,
  deleting,
  onBusyChange,
  onSaved,
  onDelete,
  onError,
}: {
  note: UserNote;
  onBusyChange: (busy: boolean) => void;
  deleting: boolean;
  onSaved: (note: UserNote) => void;
  onDelete: () => void;
  onError: (message: string) => void;
}) {
  const t = useTranslations('notes');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();

  const [title, setTitle] = useState(note.title);
  const [groupName, setGroupName] = useState(note.groupName);
  const [content, setContent] = useState(note.content);
  const [saving, setSaving] = useState(false);

  const dirty = title !== note.title || groupName !== note.groupName || content !== note.content;

  async function save(): Promise<void> {
    if (saving || deleting) return;
    setSaving(true);
    onBusyChange(true);
    try {
      onSaved(await apiSend<UserNote>('PUT', `/api/notes/${note.id}`, { title, groupName, content }));
    } catch (caught) {
      onError(toMessage(caught));
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <fieldset disabled={saving || deleting} aria-busy={saving || deleting || undefined} data-testid="note-card" className="min-w-0 space-y-4 rounded-xl border border-line bg-surface/60 p-5">
      <Field label={t('noteTitle')}>
        <TextInput value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label={t('group')}>
        <TextInput value={groupName} onChange={(event) => setGroupName(event.target.value)} />
      </Field>
      <Field label={t('content')} hint={t('lengthHint', { count: String(content.length), max: String(MAX_NOTE_LENGTH) })}>
        <TextArea
          rows={4}
          value={content}
          maxLength={MAX_NOTE_LENGTH}
          onChange={(event) => setContent(event.target.value)}
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" busy={saving} disabled={!dirty} onClick={() => void save()}>
          {common('save')}
        </Button>
        <Button variant="danger" size="sm" busy={deleting} onClick={onDelete}>
          {common('delete')}
        </Button>
      </div>
    </fieldset>
  );
}

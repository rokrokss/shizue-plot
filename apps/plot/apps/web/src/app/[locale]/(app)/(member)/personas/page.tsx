'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/Avatar';
import { CreatorTabs } from '@/components/CreatorTabs';
import { Button, ErrorText, Field, Section, Spinner, TextArea, TextInput } from '@/components/ui';
import { apiDelete, apiGet, apiSend, apiUpload } from '@/lib/api';
import type { Persona } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';

export default function PersonasPage() {
  const t = useTranslations('personas');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();
  useDocumentTitle(t('title'));

  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      setPersonas(await apiGet<Persona[]>('/api/personas'));
    } catch (caught) {
      setError(toMessage(caught));
    }
  }, [toMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    if (busy) return;
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await apiSend<Persona>('POST', '/api/personas', {
        name: name.trim(),
        description,
      });
      setPersonas((current) => [...(current ?? []), created]);
      setName('');
      setDescription('');
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
      await apiDelete(`/api/personas/${id}`);
      setPersonas((current) => (current ?? []).filter((persona) => persona.id !== id));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setDeleting((current) => { const next = new Set(current); next.delete(id); return next; });
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-10">
      <div className="mb-6">
        <CreatorTabs />
      </div>
      <h1 className="title2 sm:title1">{t('title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('subtitle')}</p>

      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      {/* On a wide screen the form for a new one stands beside the list and stays
          in view while it scrolls, so the page fills the width the tabs above
          share with 내 플롯; a narrow one stacks them. */}
      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-6">
        <div className="lg:sticky lg:top-20">
          <Section title={t('new')} busy={busy}>
            <Field label={t('name')}>
              <TextInput
                value={name}
                placeholder={t('namePlaceholder')}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label={t('description')}>
              <TextArea
                rows={3}
                value={description}
                placeholder={t('descriptionPlaceholder')}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Button
              variant="primary"
              busy={busy}
              disabled={!name.trim()}
              onClick={() => void create()}
            >
              {t('create')}
            </Button>
          </Section>
        </div>
        <div className="space-y-4">
          {personas === null ? (
            <div className="flex justify-center py-10">
              <Spinner label={common('loading')} />
            </div>
          ) : personas.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{t('empty')}</p>
          ) : (
            personas.map((persona) => (
              <PersonaCard
                key={persona.id}
                persona={persona}
                deleting={deleting.has(persona.id)}
                onSaved={(saved) =>
                  setPersonas((current) =>
                    (current ?? []).map((item) => (item.id === saved.id ? saved : item)),
                  )
                }
                onDelete={() => void remove(persona.id)}
                onError={setError}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function PersonaCard({
  persona,
  deleting,
  onSaved,
  onDelete,
  onError,
}: {
  persona: Persona;
  deleting: boolean;
  onSaved: (persona: Persona) => void;
  onDelete: () => void;
  onError: (message: string) => void;
}) {
  const t = useTranslations('personas');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();

  const [name, setName] = useState(persona.name);
  const [description, setDescription] = useState(persona.description);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const dirty = name !== persona.name || description !== persona.description;
  const busy = saving || deleting || uploading;

  async function save(): Promise<void> {
    if (busy) return;
    setSaving(true);
    try {
      onSaved(await apiSend<Persona>('PUT', `/api/personas/${persona.id}`, { name, description }));
    } catch (caught) {
      onError(toMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset disabled={busy} aria-busy={busy || undefined} className="min-w-0 space-y-4 border border-line bg-surface/60 p-5">
      <PersonaAvatarPicker
        persona={persona}
        name={name}
        onChange={onSaved}
        onBusyChange={setUploading}
      />
      <Field label={t('name')}>
        <TextInput value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={t('description')}>
        <TextArea
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
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

/**
 * The persona's picture, as a member's avatar is set in the studio: the upload
 * answers with the persona alone, so it takes effect at once and leaves the name
 * and description being written beside it standing — and the preview is
 * cache-busted, since the URL is derived from the persona id and a replaced
 * image would otherwise be the browser's old copy.
 */
function PersonaAvatarPicker({
  persona,
  name,
  onChange,
  onBusyChange,
}: {
  persona: Persona;
  /** The name as it is being written, for the initial while there is no picture. */
  name: string;
  onChange: (persona: Persona) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useTranslations('personas');
  const toMessage = useErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  async function run(send: () => Promise<Persona>): Promise<void> {
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

  const path = `/api/personas/${persona.id}/avatar`;

  return (
    <div className="flex items-center gap-3">
      <Avatar
        src={persona.avatarUrl ? `${persona.avatarUrl}?v=${version}` : null}
        name={name || persona.name}
        className="size-14 text-xl"
      />
      <div className="flex flex-col items-start gap-1">
        <input
          ref={fileInput}
          data-testid="persona-avatar-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (picked) void run(() => apiUpload<Persona>(path, picked));
          }}
        />
        <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
          {busy ? t('avatarUploading') : t('avatarUpload')}
        </Button>
        {persona.avatarUrl ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => apiSend<Persona>('DELETE', path))}
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

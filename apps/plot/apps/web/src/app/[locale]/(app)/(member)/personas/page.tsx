'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { CreatorTabs } from '@/components/CreatorTabs';
import { Button, ErrorText, Field, Section, Spinner, TextArea, TextInput } from '@/components/ui';
import { apiDelete, apiGet, apiSend } from '@/lib/api';
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
    <div className="mx-auto w-full max-w-3xl px-5 py-10">
      <div className="mb-6">
        <CreatorTabs />
      </div>
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('subtitle')}</p>

      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      <div className="mt-6 space-y-4">
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

  const dirty = name !== persona.name || description !== persona.description;

  async function save(): Promise<void> {
    if (saving || deleting) return;
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
    <fieldset disabled={saving || deleting} aria-busy={saving || deleting || undefined} className="min-w-0 space-y-4 border border-line bg-surface/60 p-5">
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

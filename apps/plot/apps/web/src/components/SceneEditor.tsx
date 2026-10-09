'use client';

import { isNarration, narrationBody } from '@shizue/core/narration';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/types';
import { Button, TextArea, cx } from './ui';

/** One message of the scene as the server takes it back. */
export interface SceneBlock {
  /** The message this block came from; absent on a block the reader added. */
  originId?: string;
  kind: 'narration' | 'dialogue';
  /** Narration without its prefix — the server writes that part. */
  content: string;
}

/** The same block plus a key React can hold it by while the list is edited. */
interface DraftBlock extends SceneBlock {
  key: string;
}

const toDraft = (message: ChatMessage): DraftBlock =>
  isNarration(message.content)
    ? {
        key: message.id,
        originId: message.id,
        kind: 'narration',
        content: narrationBody(message.content),
      }
    : { key: message.id, originId: message.id, kind: 'dialogue', content: message.content };

/**
 * The scene — narration and replies with none of the reader's own dialogue in it —
 * edited as one block of text per message.
 *
 * Every block that came from a message is sent back with its id whether it was
 * touched or not: where the rewrite stopped matching the branch is the server's to
 * work out, and it forks there rather than overwriting anything.
 */
export function SceneEditor({
  scene,
  characterName,
  youName,
  disabled,
  onCancel,
  onSave,
}: {
  /** The messages of the scene, oldest first. */
  scene: ChatMessage[];
  characterName: string;
  youName: string;
  /** True while a reply streams — saving would fork under a moving head. */
  disabled: boolean;
  onCancel: () => void;
  onSave: (blocks: SceneBlock[]) => Promise<void>;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const [blocks, setBlocks] = useState<DraftBlock[]>(() => scene.map(toDraft));
  const [busy, setBusy] = useState(false);
  /** Keys for the blocks the reader adds; only React ever reads them. */
  const added = useRef(0);

  const roleOf = (block: DraftBlock): string => {
    const origin = block.originId ? scene.find((message) => message.id === block.originId) : undefined;
    // A block the reader adds is theirs when it is narration and the character's
    // when it is a line — the same rule the server rebuilds by.
    return (origin?.role ?? (block.kind === 'narration' ? 'user' : 'assistant')) === 'user'
      ? youName
      : characterName;
  };

  const update = (index: number, content: string): void =>
    setBlocks((current) =>
      current.map((block, at) => (at === index ? { ...block, content } : block)),
    );

  const remove = (index: number): void =>
    setBlocks((current) => current.filter((_, at) => at !== index));

  const append = (kind: SceneBlock['kind']): void => {
    added.current += 1;
    setBlocks((current) => [...current, { key: `added-${added.current}`, kind, content: '' }]);
  };

  const incomplete = blocks.length === 0 || blocks.some((block) => !block.content.trim());

  return (
    <fieldset disabled={busy} aria-busy={busy || undefined} className="min-w-0 space-y-3 rounded-xl border border-line bg-surface/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-fg">{t('sceneTitle')}</h3>
        <p className="text-xs text-muted">{t('sceneHint')}</p>
      </div>

      {blocks.map((block, index) => {
        /* Whose block this is, said once: over the field for the eye, and on the
           field itself for a reader who only ever hears one of the two. */
        const label = block.kind === 'narration' ? t('sceneNarration') : roleOf(block);
        return (
          <div key={block.key} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span
                className={cx(
                  'text-xs font-medium',
                  block.kind === 'narration' ? 'text-muted italic' : 'text-muted',
                )}
              >
                {label}
              </span>
              <button
                type="button"
                disabled={blocks.length === 1}
                onClick={() => remove(index)}
                className="text-xs text-muted transition-colors hover:text-danger focus-visible:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-30 disabled:hover:text-muted"
              >
                {t('sceneRemove')}
              </button>
            </div>
            <TextArea
              aria-label={label}
              rows={Math.min(12, Math.max(2, block.content.split('\n').length + 1))}
              value={block.content}
              onChange={(event) => update(index, event.target.value)}
              className={cx(block.kind === 'narration' && 'text-muted italic')}
            />
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => append('narration')}>
          {t('sceneAddNarration')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => append('dialogue')}>
          {t('sceneAddDialogue')}
        </Button>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {common('cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            busy={busy}
            disabled={disabled || incomplete}
            title={disabled ? t('lockedWhileGenerating') : undefined}
            onClick={async () => {
              if (busy || disabled || incomplete) return;
              setBusy(true);
              try {
                await onSave(blocks.map(({ key: _key, ...block }) => block));
              } catch {
                // The page presents the error; leave the submitted draft intact.
              } finally {
                setBusy(false);
              }
            }}
          >
            {common('save')}
          </Button>
        </div>
      </div>
    </fieldset>
  );
}

// @vitest-environment jsdom
/**
 * The reader's half of the plot's two style features, in the notes panel.
 *
 * A toggle is only offered where the plot asked for the feature: the columns
 * behind them are true on every chat, so a panel that showed them unconditionally
 * would offer to turn off something that was never going to happen. What is
 * checked here is that rule and the answer each row sends.
 *
 * `createElement` rather than JSX, matching `chatSettings.test.ts`.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: unknown }) =>
    createElement('a', { href }, children as never),
}));

const { ChatPanel } = await import('../src/components/ChatPanel');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;
/** Every toggle the panel has sent, as `feature: answer`. */
let sent: string[];
let saveNote: () => Promise<void> = async () => undefined;

function render(features: { statusWindow: boolean; choices: boolean }): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        timeZone: 'Asia/Seoul',
        messages,
        children: createElement(ChatPanel, {
          members: [],
          note: '',
          notes: [],
          noteIds: [],
          memory: null,
          memorySettings: null,
          relationship: null,
          relationshipEnabled: true,
          narrator: null,
          illustrations: [],
          customUi: true,
          allowComponentTurns: false,
          statusWindow: features.statusWindow,
          statusWindowEnabled: true,
          choices: features.choices,
          choicesEnabled: true,
          disabled: false,
          onSaveNote: () => saveNote(),
          onToggleNote: async () => undefined,
          onSaveMemory: async () => undefined,
          onSaveMemorySettings: async () => undefined,
          onToggleRelationship: async () => undefined,
          onSaveNarrator: async () => undefined,
          onToggleCustomUi: () => undefined,
          onToggleComponentTurns: async () => undefined,
          onToggleStatusWindow: async (enabled: boolean) => void sent.push(`status:${enabled}`),
          onToggleChoices: async (enabled: boolean) => void sent.push(`choices:${enabled}`),
        }),
      }),
    );
  });
}

const section = (): HTMLElement | null =>
  host.querySelector('[data-testid="chat-plot-features"]');
const box = (label: string): HTMLInputElement =>
  [...(section()?.querySelectorAll('label') ?? [])]
    .find((node) => node.textContent === label)!
    .querySelector('input')!;

beforeEach(() => {
  sent = [];
  saveNote = async () => undefined;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the plot features in the notes panel', () => {
  it('says nothing where the plot asked for neither feature', () => {
    render({ statusWindow: false, choices: false });
    expect(section()).toBeNull();
  });

  it('offers only the feature the plot turned on', () => {
    render({ statusWindow: true, choices: false });
    expect(section()).not.toBeNull();
    expect(section()!.textContent).toContain(messages.chat.statusWindowEnabled);
    expect(section()!.textContent).not.toContain(messages.chat.choicesEnabled);
  });

  it('sends each answer as the reader gives it', async () => {
    render({ statusWindow: true, choices: true });

    await act(async () => {
      box(messages.chat.statusWindowEnabled).click();
    });
    await act(async () => {
      box(messages.chat.choicesEnabled).click();
    });
    expect(sent).toEqual(['status:false', 'choices:false']);
  });
});

it('locks note and narrator drafts while its own save is pending', async () => {
  let finish!: () => void;
  saveNote = () => new Promise((resolve) => { finish = resolve; });
  render({ statusWindow: false, choices: false });
  const save = [...host.querySelectorAll('button')].find((node) => node.textContent === '저장')!;
  await act(async () => save.click());
  expect([...host.querySelectorAll('textarea')].every((node) => node.matches(':disabled'))).toBe(true);
  await act(async () => finish());
  expect([...host.querySelectorAll('textarea')].every((node) => !node.matches(':disabled'))).toBe(true);
});

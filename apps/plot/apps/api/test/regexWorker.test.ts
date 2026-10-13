/**
 * The prompt scripts' thread pool, on its own: no database, no app. A pattern
 * that never returns costs one try's deadline, is skipped from then on, and the
 * other scripts still rewrite the turns — which the assembler then sends, while
 * the stored turns stay as they were.
 */
import { assemblePrompt, DEFAULT_LORE_SETTINGS, promptText, type HistoryMessage } from '@shizue/core';
import { promptScriptJob, promptScriptsOfCard } from '@shizue/core/prompt-scripts';
import { describe, expect, it } from 'vitest';
import { PROMPT_SCRIPT_DEADLINE_MS, runPromptScriptJob } from '../src/regexWorker.js';

const editprocess = (source: string, out: string): Record<string, unknown> => ({
  comment: '',
  type: 'editprocess',
  in: source,
  out,
  ableFlag: false,
  flag: '',
});

const scriptsOf = (...customScripts: Record<string, unknown>[]) =>
  promptScriptsOfCard({ risuai: { customScripts } });

/** Counts the event loop's turns while `work` runs. */
async function ticking<T>(work: () => Promise<T>): Promise<{ result: T; ticks: number; ms: number }> {
  let ticks = 0;
  const ticker = setInterval(() => (ticks += 1), 10);
  const started = Date.now();
  try {
    const result = await work();
    return { result, ticks, ms: Date.now() - started };
  } finally {
    clearInterval(ticker);
  }
}

describe('runPromptScriptJob', () => {
  it('rewrites the greeting and the turns in a thread, lookbehind and all', async () => {
    const history = [
      { role: 'assistant' as const, content: 'greet <status>hp 3</status>' },
      { role: 'user' as const, content: 'hello world' },
    ];
    const texts = await runPromptScriptJob(
      promptScriptJob(
        history,
        scriptsOf(editprocess('<status>[\\s\\S]*?</status>', ''), editprocess('(?<=hello )world', 'there')),
        { length: 2, greeting: { text: history[0]!.content } },
      ),
    );
    expect(texts).toEqual(['greet ', 'hello there']);
  });

  it('cuts off a catastrophic pattern without stalling the loop, skips it from then on, and runs the rest', async () => {
    const turn = `${'a'.repeat(40)}b`;
    const job = promptScriptJob([{ role: 'user', content: turn }], scriptsOf(editprocess('^(a+)+$', 'X'), editprocess('b$', 'B')));

    const first = await ticking(() => runPromptScriptJob(job));
    expect(first.result).toEqual([`${'a'.repeat(40)}B`]);
    expect(first.ms).toBeLessThan(PROMPT_SCRIPT_DEADLINE_MS * 5);
    // The thread was stuck, not the server: the loop kept turning meanwhile.
    expect(first.ticks).toBeGreaterThan(5);

    // Skipped from the start now, so there is no deadline to wait out.
    const again = await ticking(() => runPromptScriptJob(job));
    expect(again.result).toEqual([`${'a'.repeat(40)}B`]);
    expect(again.ms).toBeLessThan(PROMPT_SCRIPT_DEADLINE_MS);
  });

  it('sends the turns as stored when every script runs out of time', async () => {
    const turn = `${'c'.repeat(60)}d`;
    const texts = await runPromptScriptJob(
      promptScriptJob([{ role: 'user', content: turn }], scriptsOf(editprocess('^(c+)+$', 'X'), editprocess('^(c|cc)+$', 'Y'))),
    );
    expect(texts).toEqual([turn]);
  });

  it('hands the assembler what to send, and leaves the stored turns alone', async () => {
    const history: HistoryMessage[] = [
      { role: 'assistant', content: '어서 와. <status>HP 3</status>' },
      { role: 'user', content: `${'e'.repeat(40)}f` },
    ];
    const stored = structuredClone(history);
    const texts = await runPromptScriptJob(
      promptScriptJob(history, scriptsOf(editprocess('<status>.*?</status>', ''), editprocess('^(e+)+$', 'X'))),
    );
    const scripted = history.map((turn, index) =>
      texts[index] === turn.content ? turn : { ...turn, promptContent: texts[index]! },
    );
    const { messages } = assemblePrompt({
      plot: { name: '작품', description: '', lorebook: [] },
      characters: [
        {
          name: '아리아',
          card: {
            spec: 'v3',
            name: '아리아',
            description: '',
            personality: '',
            scenario: '',
            firstMes: '',
            alternateGreetings: [],
            mesExample: '',
            systemPrompt: '',
            postHistoryInstructions: '',
            creatorNotes: '',
            tags: [],
            creator: '',
            characterVersion: '',
            lorebook: [],
            loreSettings: { ...DEFAULT_LORE_SETTINGS },
            extensions: {},
            raw: null,
          },
        },
      ],
      history: scripted,
      preset: { main: 'MAIN', postHistory: 'POST' },
    });
    expect(messages.map((message) => promptText(message.content))).toEqual(['어서 와. ', `${'e'.repeat(40)}f`, 'POST']);
    expect(history).toEqual(stored);
  });
});

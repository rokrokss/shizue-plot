import { assemblePrompt, countTokens, parseCard } from '@shizue/core';
import { describe, expect, it } from 'vitest';
import { v1Card } from '../../../packages/core/test/fixtures/cards.js';
import {
  ROLEPLAY_JAILBREAK_MAIN,
  ROLEPLAY_JAILBREAK_POST_HISTORY,
  ROLEPLAY_JAILBREAK_TOKENS,
  withRoleplayJailbreak,
} from '../src/roleplayJailbreak.js';
import { withEditedRequest } from '../src/requestTriggers.js';

const budget = 4096;
const makePrompt = () => assemblePrompt({
  plot: { name: '골짜기', description: '눈 내리는 밤.', lorebook: [] },
  characters: [{ name: '아리아', card: parseCard(v1Card).card }],
  history: [{ id: 'u1', role: 'user', content: '안녕' }],
  userName: '유저',
  memoryText: '[지난 이야기 요약]\n둘은 만났다.',
  contextBudget: budget - ROLEPLAY_JAILBREAK_TOKENS,
  report: true,
});

describe('always-on roleplay instructions', () => {
  it('charges the final request and keeps its inspector, cache sections and memory view aligned', () => {
    const prompt = makePrompt();
    const before = structuredClone(prompt);
    const sent = withRoleplayJailbreak(prompt, budget, false);
    const added = countTokens(sent.system) - countTokens(prompt.system) + countTokens(ROLEPLAY_JAILBREAK_POST_HISTORY);
    expect(sent.system).toBe(`${ROLEPLAY_JAILBREAK_MAIN}\n\n${prompt.system}`);
    expect(sent.messages.at(-1)).toEqual({ role: 'system', content: ROLEPLAY_JAILBREAK_POST_HISTORY });
    expect(sent.sources).toEqual([...prompt.sources!, { kind: 'post_history' }]);
    expect(sent.systemSections).toEqual([{ kind: 'main', text: ROLEPLAY_JAILBREAK_MAIN }, ...prompt.systemSections!]);
    expect(sent.risu!.memory!.system).toBe(`${ROLEPLAY_JAILBREAK_MAIN}\n\n${prompt.risu!.memory!.system}`);
    expect(sent.fixedTokens).toBe(prompt.fixedTokens! + added);
    expect(sent.report!.totals).toEqual({ ...prompt.report!.totals, contextBudget: budget, used: prompt.report!.totals.used + added });
    expect(sent.report!.blocks.map((b) => b.text)).toEqual([
      ROLEPLAY_JAILBREAK_MAIN, ...prompt.report!.blocks.map((b) => b.text), ROLEPLAY_JAILBREAK_POST_HISTORY,
    ]);
    expect(added).toBeLessThanOrEqual(ROLEPLAY_JAILBREAK_TOKENS);
    expect(prompt).toEqual(before);
  });

  it('keeps a continuation or bias last in the request, sources and inspector', () => {
    const prompt = makePrompt();
    const partial = '말을 잇다가';
    prompt.messages.push({ role: 'assistant', content: partial });
    prompt.sources!.push({ kind: 'history', id: 'partial' });
    prompt.report!.blocks.push({ kind: 'history', label: 'assistant', text: partial, tokens: countTokens(partial) });
    const sent = withRoleplayJailbreak(prompt, budget, true);
    expect(sent.messages.slice(-2)).toEqual([
      { role: 'system', content: ROLEPLAY_JAILBREAK_POST_HISTORY }, { role: 'assistant', content: partial },
    ]);
    expect(sent.sources!.slice(-2)).toEqual([{ kind: 'post_history' }, { kind: 'history', id: 'partial' }]);
    expect(sent.report!.blocks.slice(-2).map((b) => b.text)).toEqual([ROLEPLAY_JAILBREAK_POST_HISTORY, partial]);
    // An ordinary assistant history turn is not a prefill.
    expect(withRoleplayJailbreak(prompt, budget, false).messages.at(-1)!.content).toBe(ROLEPLAY_JAILBREAK_POST_HISTORY);
  });

  it('survives an editor replacing the entire request and dropping its system', async () => {
    const edited = await withEditedRequest(makePrompt(), async () => [{ role: 'user', content: '새 질문' }], 'test');
    expect(edited.system).toBe('');
    const sent = withRoleplayJailbreak(edited, budget, false);
    expect(sent.system).toBe(ROLEPLAY_JAILBREAK_MAIN);
    expect(sent.messages).toEqual([
      { role: 'user', content: '새 질문' }, { role: 'system', content: ROLEPLAY_JAILBREAK_POST_HISTORY },
    ]);
    expect(sent.report!.blocks.map((b) => b.text)).toEqual([
      ROLEPLAY_JAILBREAK_MAIN, '새 질문', ROLEPLAY_JAILBREAK_POST_HISTORY,
    ]);
  });
});

/**
 * RisuAI's ways of writing a chat as one text (`stringlize.ts`): the instruct
 * templates word for word, NovelAI's and NovelList's transcripts, the legacy
 * OpenAI and Claude prompts, and the strings a continuation is cut at.
 */
import { describe, expect, it } from 'vitest';
import { INSTRUCT_TEMPLATE_NAMES } from '../src/instructTemplates.js';
import { parseModelParams } from '../src/params.js';
import { Strip } from '../src/stream.js';
import {
  applyChatTemplate,
  claudeLegacyPrompt,
  legacyInstructPrompt,
  novelAIPrompt,
  novelListPrompt,
  novelListReply,
  oobaStopStrings,
  speakerChunks,
  speakersOf,
  textTurns,
  type TextTurn,
} from '../src/stringlize.js';
import { REQUEST, thrown } from './helpers.js';

const names = { char: 'Lia', user: 'Rin' };
const turns: TextTurn[] = [
  { role: 'system', content: 'S' },
  { role: 'user', content: 'U' },
  { role: 'assistant', content: 'A' },
];

describe('the instruct templates', () => {
  it('write ChatML, Llama 3 and Alpaca as RisuAI does, with the generation prompt last', () => {
    expect(applyChatTemplate(turns, { ...names })).toBe(
      '<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nU<|im_end|>\n<|im_start|>assistant\nA<|im_end|>\n<|im_start|>assistant\n',
    );
    expect(applyChatTemplate(turns, { template: 'llama3', ...names })).toBe(
      '<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nS<|eot_id|><|start_header_id|>user<|end_header_id|>\n\nU<|eot_id|>'
      + '<|start_header_id|>assistant<|end_header_id|>\n\nA<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n',
    );
    expect(applyChatTemplate(turns.slice(1), { template: 'alpaca', ...names })).toBe(
      'Below is an instruction that describes a task. Write a response that appropriately completes the request.\n\n'
      + '### Instruction:\nU\n\n### Response:\nA\n\n### Response:\n',
    );
    expect(applyChatTemplate(turns, { template: 'vicuna', ...names })).toBe('S\n\nUSER: U\nASSISTANT: A</s>\nASSISTANT:');
  });

  it("give Mistral's no system turn and alternating roles, and Gemma's no system turn", () => {
    const mixed: TextTurn[] = [
      { role: 'system', content: 'S' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'U' }, { role: 'system', content: 'N' },
    ];
    expect(applyChatTemplate(mixed, { template: 'mistral', ...names })).toBe(' [INST] System: S [/INST] A  [INST] U\nSystem: N [/INST]');
    // An opening reply gets an empty user turn before it.
    expect(applyChatTemplate([{ role: 'assistant', content: 'A' }], { template: 'mistral', ...names })).toBe(' [INST]  [/INST] A ');
    expect(applyChatTemplate([{ role: 'system', content: 'S' }, { role: 'assistant', content: 'A' }], { template: 'gemma', ...names }))
      .toBe('<start_of_turn>user\nSystem: S<end_of_turn>\n<start_of_turn>model\nA<end_of_turn>\n<start_of_turn>model\n');
  });

  it("read a preset's own Jinja with the speakers' names, and refuse what does not render", () => {
    const jinja = '{{ risu_char }}/{{ risu_user }}{% for m in messages %}|{{ m.role }}:{{ m.content }}{% endfor %}';
    expect(applyChatTemplate(turns, { template: 'jinja', jinja, ...names })).toBe('Lia/Rin|system:S|user:U|assistant:A');
    // Llama 2's own template refuses roles that do not alternate.
    expect(thrown(() => applyChatTemplate([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], { template: 'llama2', ...names })))
      .toMatchObject({ code: 'template_failed', status: 400, detail: expect.stringContaining('alternate') });
    expect(thrown(() => applyChatTemplate(turns, { template: 'nope', ...names }))).toMatchObject({ code: 'template_invalid' });
    expect(thrown(() => applyChatTemplate(turns, { template: 'jinja', ...names }))).toMatchObject({ code: 'template_invalid' });
  });

  it('are what a preset may name, and its own must parse', () => {
    expect(INSTRUCT_TEMPLATE_NAMES).toEqual(['llama3', 'llama2', 'chatml', 'gpt2', 'gemma', 'mistral', 'vicuna', 'alpaca', 'jinja']);
    expect(parseModelParams({ instructTemplate: 'jinja', jinjaTemplate: '{{ messages[0].content }}' })).toEqual({ instructTemplate: 'jinja', jinjaTemplate: '{{ messages[0].content }}' });
    for (const bad of [{ instructTemplate: 'llama9' }, { jinjaTemplate: '{% for %}' }, { jinjaTemplate: 'x'.repeat(16 * 1024 + 1) }]) {
      expect(() => parseModelParams(bad), JSON.stringify(bad).slice(0, 60)).toThrow(TypeError);
    }
  });
});

describe('the turns a text format writes', () => {
  it("put the system text first and arrange the turns by the model's flags", () => {
    expect(textTurns(REQUEST, {})).toEqual([
      { role: 'system', content: 'You are the narrator.' },
      { role: 'system', content: '[Start a new chat]' },
      { role: 'assistant', content: 'The door creaks open.' },
      { role: 'user', content: 'Who is there?' },
      { role: 'system', content: 'Reply in two paragraphs.' },
    ]);
    expect(textTurns(REQUEST, { systemPrompt: 'first' })).toEqual([
      { role: 'system', content: 'You are the narrator.\n\n[Start a new chat]' },
      { role: 'assistant', content: 'The door creaks open.' },
      { role: 'user', content: 'Who is there?' },
      { role: 'user', content: 'system: Reply in two paragraphs.' },
    ]);
    expect(speakersOf({})).toEqual({ char: 'Assistant', user: 'User' });
  });

  it("are cut where another speaker's line starts (RisuAI's stop strings and unstringlizer chunks)", () => {
    const stops = oobaStopStrings('Rin');
    expect(stops).toEqual(expect.arrayContaining(['Rin:', '</s>', '<|im_end', '### Input:', 'user:', 'USER:', 'User:', '<<Human>>', '### INSTRUCTION']));
    expect(new Set(stops).size).toBe(stops.length);
    expect(speakerChunks('Lia', 'Rin')).toEqual(['system note:', 'system:', 'system note：', 'system：', 'Lia:', 'Lia：', 'Lia: ', 'Lia： ', 'Rin:', 'Rin：', 'Rin: ', 'Rin： ']);
    expect(speakerChunks('Lia', 'Rin', 'ain').slice(4)).toEqual(['Lia ', 'Lia　', 'Rin ', 'Rin　']);
  });
});

describe('the transcripts', () => {
  it("write NovelAI's: names before the turns, a new chat as ⁂, and the character's name last unless it goes on", () => {
    const novel = textTurns(REQUEST, {});
    expect(novelAIPrompt(novel, 'Lia', 'Rin')).toBe('You are the narrator.\n⁂\nLia: The door creaks open.\nRin: Who is there?\nReply in two paragraphs.\nLia:');
    expect(novelAIPrompt([...novel, { role: 'assistant', content: 'Me' }], 'Lia', 'Rin').endsWith('\nLia: Me')).toBe(true);
  });

  it("write NovelList's quotes after their speakers, and read its reply as the character's part", () => {
    const novel: TextTurn[] = [
      { role: 'system', content: 'S' },
      { role: 'system', content: '[Start a new chat]' },
      { role: 'assistant', content: 'She said "hello" and "bye".' },
      { role: 'user', content: '"Who?" I ask.' },
    ];
    expect(novelListPrompt(novel, 'Lia', 'Rin')).toBe(
      'S\n\n[新しいチャットの始まり]\n\nShe said \n\nLia 「hello」\n\n and \n\nLia 「bye」\n\n.\n\nRin 「Who?」\n\n I ask.\n\nLia 「',
    );
    expect(novelListPrompt([...novel, { role: 'assistant', content: 'Hm' }], 'Lia', 'Rin').endsWith('\n\nHm 「')).toBe(true);
    expect(novelListReply('こんにちは」と笑った。\n\nLia 「またね」\n\nRin 「誰？」\n\nLia 「ふふ」', 'Lia', 'Rin')).toBe('「こんにちは」\nと笑った。\n「またね」\n');
    expect(novelListReply('はい', 'Lia', 'Rin')).toBe('「はい」');
  });

  it("write the legacy OpenAI instruct prompt and Anthropic's Text Completions prompt", () => {
    expect(legacyInstructPrompt([...turns, { role: 'user', content: '  ' }])).toBe('\n## Instruction\nS\n## User\nU\n## Assistant\nA\n## Response\n');
    const asking = turns.slice(0, 2);
    // Claude 2.1 reads a first system turn bare, as its system prompt.
    expect(claudeLegacyPrompt(asking, 'claude-2.1')).toBe('\n\nHuman: S\n\nHuman: U\n\nAssistant: ');
    expect(claudeLegacyPrompt(asking, 'claude-2.0')).toBe('\n\nHuman: \n\nSystem: S\n\nHuman: U\n\nAssistant: ');
    expect(claudeLegacyPrompt(turns, 'claude-instant-1.2')).toBe('\n\nHuman: \n\nSystem: S\n\nHuman: U\n\nAssistant: A');
  });
});

describe('a string taken out as the text arrives', () => {
  it('is taken out across pieces, in one pass as the replace makes it', () => {
    const strip = new Strip('##\n');
    const out = ['ab#', '#', '\ncd##', '\n', '##\nx', '#'].map((piece) => strip.push(piece)).join('') + strip.flush();
    expect(out).toBe('ab' + 'cd' + 'x#');
    expect('ab##\ncd##\n##\nx#'.replace(/##\n/g, '')).toBe(out);
    const once = new Strip('##\n');
    expect(once.push('###\n\n') + once.flush()).toBe('#\n');
  });
});

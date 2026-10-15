import { describe, expect, it } from 'vitest';
import { extractTavernBias, removeTavernMacros, withoutTavernBias } from '../src/tavernBias.js';

describe('SillyTavern {{bias}}', () => {
  it("reads every bias in a turn as ST's extractMessageBias does: joined by a space, after one", () => {
    // script.js `extractMessageBias`: a Handlebars `bias` helper collects each
    // argument, and the result is ` ${matches.join(' ')}`.
    expect(extractTavernBias('{{bias "그녀는 웃으며"}}안녕')).toBe(' 그녀는 웃으며');
    expect(extractTavernBias(`{{bias 'A'}} 말 {{ bias "B \\"C\\"" }}`)).toBe(' A B "C"');
    expect(extractTavernBias('{{char}}에게 안녕')).toBe('');
    expect(extractTavernBias('{{bias}}')).toBe('');
  });

  it("strips every macro left in a turn that had one, as ST's removeMacros does", () => {
    // script.js `removeMacros`: /\{\{[\s\S]*?\}\}/gm, then trim.
    expect(removeTavernMacros('{{bias "x"}} 안녕 {{unknown::1}}\n')).toBe('안녕');
    expect(removeTavernMacros('{{bias "x"}}')).toBe('');
  });

  it('takes a repeated bias off the start of a reply, and leaves any other reply as it came', () => {
    expect(withoutTavernBias('그녀는 웃으며 말했다.', ' 그녀는 웃으며')).toBe(' 말했다.');
    expect(withoutTavernBias('\n그녀는 웃으며', '그녀는 웃으며')).toBe('');
    expect(withoutTavernBias('그는 웃었다.', ' 그녀는 웃으며')).toBe('그는 웃었다.');
    expect(withoutTavernBias('그대로', '')).toBe('그대로');
  });
});

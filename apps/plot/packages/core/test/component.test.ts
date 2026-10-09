import { describe, expect, it } from 'vitest';
import {
  componentNames,
  componentSubsetViolations,
  MAX_COMPONENT_CODE_LENGTH,
} from '../src/component.js';
import { exportCardV3 } from '../src/card/export.js';
import { normalizeCard } from '../src/card/normalize.js';
import type { NormalizedCard } from '../src/types.js';

const STATUS = `
function StatusWindow({ hp = 0, platform }) {
  const [open, setOpen] = useState(false);
  const half = useMemo(() => hp / 2, [hp]);
  return (
    <div style={{ padding: 8 }}>
      HP {hp} / {half} · {platform.variables.gold}
      <button onClick={() => setOpen(!open)}>더보기</button>
    </div>
  );
}
`;

describe('the subset screen', () => {
  it('passes a component written the way the Elyn ones are', () => {
    expect(componentSubsetViolations(STATUS)).toEqual([]);
  });

  it('names what a component reached for outside the subset', () => {
    expect(componentSubsetViolations('import React from "react";')).toEqual(['import']);
    expect(componentSubsetViolations('setInterval(tick, 100)')).toEqual(['timer']);
    expect(componentSubsetViolations('fetch("/api/models")')).toEqual(['network']);
    expect(componentSubsetViolations('localStorage.setItem("a", 1)')).toEqual(['storage']);
    expect(componentSubsetViolations('eval("1")')).toEqual(['eval']);
    expect(componentSubsetViolations('<div className="a" />')).toEqual(['class_name']);
    expect(componentSubsetViolations('<div style="color: red" />')).toEqual(['string_style']);
    expect(componentSubsetViolations('useReducer(f, 0)')).toEqual(['unknown_hook']);
    expect(componentSubsetViolations('a'.repeat(MAX_COMPONENT_CODE_LENGTH + 1))).toEqual(['too_long']);
  });

  it('reads only code, so a forbidden word in a string or a comment is neither', () => {
    expect(componentSubsetViolations('const label = "fetch the sword";')).toEqual([]);
    expect(componentSubsetViolations('// setTimeout is not allowed here\n')).toEqual([]);
    expect(componentSubsetViolations('/* localStorage */ const a = 1;')).toEqual([]);
    expect(componentSubsetViolations('const t = `no className here`;')).toEqual([]);
  });

  it('allows every whitelisted hook and refuses the rest', () => {
    expect(
      componentSubsetViolations(
        'useState(1); useEffect(f, []); useMemo(f, []); useCallback(f, []); useRef(null);',
      ),
    ).toEqual([]);
    expect(componentSubsetViolations('useLayoutEffect(f, [])')).toEqual(['unknown_hook']);
  });
});

describe('the declared names', () => {
  it('finds both declaration forms, in order, without duplicates', () => {
    expect(componentNames(STATUS)).toEqual(['StatusWindow']);
    expect(componentNames('const Gauge = () => null;\nfunction Panel() {}\nconst Gauge2 = 1;')).toEqual([
      'Gauge',
      'Panel',
      'Gauge2',
    ]);
  });

  it('ignores lowercase declarations and text that only looks like one', () => {
    expect(componentNames('function helper() {}\nconst value = 1;')).toEqual([]);
    expect(componentNames('const s = "function Fake(";')).toEqual([]);
  });
});

describe('the card round trip', () => {
  /** A V2 card the way RisuAI exports one, so the interop block is really there. */
  const source = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '루미',
      description: '컴포넌트를 쓰는 캐릭터.',
      personality: '',
      scenario: '',
      first_mes: '<StatusWindow hp={100} />',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1.0',
      extensions: { risuai: { emotions: [], customScripts: [{ in: 'a', out: 'b', type: 'editinput' }] } },
    },
  };
  const card: NormalizedCard = { ...normalizeCard(source), componentCode: STATUS };

  it('exports the component code under our own namespace and imports it back', () => {
    const exported = exportCardV3(card);
    const extensions = exported.data.extensions as Record<string, Record<string, unknown>>;
    expect(extensions['shizue']?.['componentCode']).toBe(STATUS);
    // Everything that was already in extensions is still where it was.
    expect(extensions['risuai']).toBeDefined();

    expect(normalizeCard(exported).componentCode).toBe(STATUS);
  });

  it('drops component code that is over the cap instead of importing it', () => {
    // Import does not pass through the editor, so this is the only place the cap
    // is applied to a card written by a stranger. The card still arrives.
    const oversized = {
      ...source,
      data: {
        ...source.data,
        extensions: { shizue: { componentCode: 'a'.repeat(MAX_COMPONENT_CODE_LENGTH + 1) } },
      },
    };
    const imported = normalizeCard(oversized);
    expect(imported.componentCode).toBeUndefined();
    expect(imported.name).toBe('루미');

    // One character under the cap is fine.
    const allowed = {
      ...source,
      data: {
        ...source.data,
        extensions: { shizue: { componentCode: 'a'.repeat(MAX_COMPONENT_CODE_LENGTH) } },
      },
    };
    expect(normalizeCard(allowed).componentCode).toHaveLength(MAX_COMPONENT_CODE_LENGTH);
  });

  it('leaves a card that has no component code without the field', () => {
    const plain = { ...card };
    delete plain.componentCode;
    const exported = exportCardV3(plain);
    expect((exported.data.extensions as Record<string, unknown>)['shizue']).toBeUndefined();
    expect(normalizeCard(exported).componentCode).toBeUndefined();
  });

  it('round-trips the declared capabilities, and grants none by default', () => {
    // A card that never asked for anything carries no field at all, so an old
    // card is not silently reinterpreted as declaring something.
    expect(card.componentCapabilities).toBeUndefined();
    expect(normalizeCard(exportCardV3(card)).componentCapabilities).toBeUndefined();

    const asking: NormalizedCard = { ...card, componentCapabilities: ['sendTurn'] };
    const extensions = exportCardV3(asking).data.extensions as Record<
      string,
      Record<string, unknown>
    >;
    expect(extensions['shizue']?.['componentCapabilities']).toEqual(['sendTurn']);
    expect(normalizeCard(exportCardV3(asking)).componentCapabilities).toEqual(['sendTurn']);
  });

  it('drops a capability this build does not understand', () => {
    const stranger = {
      ...source,
      data: {
        ...source.data,
        extensions: { shizue: { componentCapabilities: ['sendTurn', 'impersonate'] } },
      },
    };
    // The unknown name is not kept: nothing downstream would grant it, and a card
    // may not carry a claim the platform cannot check.
    expect(normalizeCard(stranger).componentCapabilities).toEqual(['sendTurn']);

    const nonsense = {
      ...source,
      data: { ...source.data, extensions: { shizue: { componentCapabilities: 'sendTurn' } } },
    };
    expect(normalizeCard(nonsense).componentCapabilities).toBeUndefined();
  });
});

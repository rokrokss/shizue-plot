/**
 * RisuAI's display pass, transcribed as a test oracle (kwaroran/Risuai e773240;
 * PocketRisu changes none of it that this reads): `processScriptFull` in
 * `src/ts/process/scripts.ts`, and `parseThoughtsAndTools` in
 * `src/ts/parser/parser.svelte.ts`, which `ParseMarkdown` runs after it and
 * before the markdown. Copied as it stands, the parts a message's screen
 * reaches — the Lua edit, the display trigger, plugins, `@@emo` (the
 * character's emotion picture), `@@inject` (which writes the stored message)
 * and the dynamic-asset search left out, none of them in the fixtures this
 * reads. `parse` stands in for `risuChatParser`, which the CBS suites pin.
 */

/** RisuAI's `customscript`. */
export interface RisuScript {
  comment?: string;
  in: string;
  out: string;
  type: string;
  flag?: string;
  ableFlag?: boolean;
}

interface PScript {
  script: RisuScript;
  order: number;
  actions: string[];
}

const dreg = /{{data}}/g;

/**
 * `processScriptFull(char, data, mode, chatID)`: the scripts are
 * `db.presetRegex.concat(char.customscript).concat(getModuleRegexScripts())`,
 * already concatenated by the caller. `previous` is what `repeat_back` reads:
 * the last message of the same role before this one, or the greeting.
 */
export function risuProcessScriptFull(
  scripts: readonly RisuScript[],
  input: string,
  mode: string,
  parse: (text: string) => string,
  chatID = -1,
  previous = '',
): string {
  let data = parse(input);

  function executeScript(pscript: PScript): void {
    const script = pscript.script;
    if (script.in === '') return;
    if (script.type !== mode) return;

    const outScript2 = script.out.replaceAll('$n', '\n');
    let outScript = outScript2.replace(dreg, '$&');
    let flag = 'g';
    if (script.ableFlag) flag = script.flag || 'g';
    if (
      outScript.startsWith('@@move_top') ||
      outScript.startsWith('@@move_bottom') ||
      pscript.actions.includes('move_top') ||
      pscript.actions.includes('move_bottom')
    ) {
      flag = flag.replace('g', '');
    }
    if (outScript.endsWith('>') && !pscript.actions.includes('no_end_nl')) outScript += '\n';
    flag = flag.trim().replace(/[^dgimsuvy]/g, '');
    flag = flag
      .split('')
      .filter((v, i, a) => a.indexOf(v) === i)
      .join('');
    if (flag.length === 0) flag = 'u';

    let inputPattern = script.in;
    if (pscript.actions.includes('cbs')) inputPattern = parse(inputPattern);

    const reg = new RegExp(inputPattern, flag);
    if (outScript.startsWith('@@') || pscript.actions.length > 0) {
      if (reg.test(data)) {
        if (outScript.startsWith('@@emo ')) {
          // The emotion picture; the text is left as it is.
        } else if ((outScript.startsWith('@@inject') || pscript.actions.includes('inject')) && chatID !== -1) {
          data = data.replace(reg, '');
        } else if (
          outScript.startsWith('@@move_top') ||
          outScript.startsWith('@@move_bottom') ||
          pscript.actions.includes('move_top') ||
          pscript.actions.includes('move_bottom')
        ) {
          const isGlobal = flag.includes('g');
          const matchAll = isGlobal ? [...data.matchAll(reg)] : [data.match(reg)];
          data = data.replace(reg, '');
          for (const matched of matchAll) {
            if (matched) {
              const inData = matched[0];
              const out = outScript
                .replace('@@move_top ', '')
                .replace('@@move_bottom ', '')
                .replace(/(?<!\$)\$[0-9]+/g, (v) => {
                  const index = parseInt(v.substring(1));
                  if (index < matched.length) return matched[index]!;
                  return v;
                })
                .replace(/\$&/g, inData)
                .replace(/(?<!\$)\$<([^>]+)>/g, (v) => {
                  const groupName = parseInt(v.substring(2, v.length - 1));
                  const groups = matched.groups as Record<number, string> | undefined;
                  if (groups && groups[groupName]) return groups[groupName]!;
                  return v;
                });
              if (outScript.startsWith('@@move_top') || pscript.actions.includes('move_top')) data = out + '\n' + data;
              else data = data + '\n' + out;
            }
          }
        } else {
          data = parse(data.replace(reg, outScript));
        }
      } else if ((outScript.startsWith('@@repeat_back') || pscript.actions.includes('repeat_back')) && chatID !== -1) {
        const v = outScript.split(' ', 2)[1];
        const r = previous.match(reg)!;
        if (!v) data = data + r[0];
        else if (r[0]) {
          switch (v) {
            case 'end':
              data = data + r[0];
              break;
            case 'start':
              data = r[0] + data;
              break;
            case 'end_nl':
              data = data + '\n' + r[0];
              break;
            case 'start_nl':
              data = r[0] + '\n' + data;
              break;
          }
        }
      }
    } else {
      data = parse(data.replace(reg, outScript));
    }
  }

  const parsedScripts: PScript[] = [];
  let orderChanged = false;
  for (const script of scripts) {
    if (script.ableFlag && script.flag?.includes('<')) {
      const rregex = /<(.+?)>/g;
      const scriptData = structuredClone(script);
      let order = 0;
      const actions: string[] = [];
      scriptData.flag = scriptData.flag?.replace(rregex, (_v: string, p1: string) => {
        const meta = p1.split(',').map((v) => v.trim());
        for (const m of meta) {
          if (m.startsWith('order ')) {
            order = parseInt(m.substring(6));
            orderChanged = true;
          } else {
            actions.push(m);
          }
        }
        return '';
      });
      parsedScripts.push({ script: scriptData, order, actions });
      continue;
    }
    parsedScripts.push({ script, order: 0, actions: [] });
  }

  if (orderChanged) parsedScripts.sort((a, b) => b.order - a.order);
  for (const script of parsedScripts) {
    try {
      executeScript(script);
    } catch {
      // console.error(error), as there.
    }
  }
  return data;
}

/** `parseThoughtsAndTools`, with `language.cot` and `language.toolCalled` passed in. */
export function risuParseThoughtsAndTools(data: string, cot: string, toolCalled: string): string {
  let result = '';
  let i = 0;
  while (i < data.length) {
    if (data.slice(i, i + 10) === '<Thoughts>') {
      let j = i + 10;
      let depth = 1;
      while (j < data.length && depth > 0) {
        if (data.slice(j, j + 10) === '<Thoughts>') depth++;
        if (data.slice(j, j + 11) === '</Thoughts>') depth--;
        j++;
      }
      if (depth === 0) {
        result += `<details><summary>${cot}</summary>${data.substring(i + 10, j - 1)}</details>`;
        i = j + 10;
        continue;
      }
    }
    result += data[i++];
  }
  return result.replace(/<tool_call>(.+?)<\/tool_call>/gms, (_full, txt: string) => {
    return `<div class="x-risu-tool-call">🛠️ ${toolCalled.replace('{{tool}}', txt.split('')?.[1] ?? 'unknown')}</div>\n\n`;
  });
}

#!/usr/bin/env node
// PreToolUse guard for Bash: refuses the two wait patterns that left agents
// "running" for hours on 2026-10-14.
//
// 1. `pgrep -f` / `pkill -f` with a plain pattern. Every command runs as
//    `zsh -c '<command>'`, so every shell that waits on a pattern carries it in
//    its own command line, and `-f` matches those shells too (Linux's pgrep
//    even matches its own). Two loops waiting for "playwright test" to be gone
//    each saw the other and waited for hours. The bracket form
//    (`pgrep -f '[p]laywright test'`) does not match a command line that
//    spells it that way, so it is allowed — but parallel worktrees run the
//    same commands, so it should also name something only yours (a port).
// 2. `until`/`while` loops that sleep with no bound. A condition that never
//    turns leaves the loop polling forever; any timeout, `$SECONDS` check or
//    numeric counter is enough.
//
// Exit 2 blocks the call and hands the message on stderr back to the agent.

import { readFileSync } from 'node:fs';

/** pgrep/pkill options that take a value, so the next word is not the pattern. */
const TAKES_VALUE = new Set(['d', 'F', 'G', 'g', 'J', 'P', 's', 't', 'U', 'u']);

/** The words after each `pgrep`/`pkill` up to the end of that simple command. */
function invocations(command) {
  const found = [];
  const start = /\b(pgrep|pkill)\b/g;
  let match;
  while ((match = start.exec(command))) {
    const words = [];
    let word = '';
    let quote = null;
    let i = match.index + match[0].length;
    for (; i < command.length; i++) {
      const c = command[i];
      if (quote) {
        if (c === quote) quote = null;
        else word += c;
      } else if (c === "'" || c === '"') {
        quote = c;
        word += '\u0000'; // marks a quoted word, so '' still counts as a word
      } else if (/[;&|)\n]/.test(c)) {
        break;
      } else if (/\s/.test(c)) {
        if (word) words.push(word.replaceAll('\u0000', ''));
        word = '';
      } else {
        word += c;
      }
    }
    if (word) words.push(word.replaceAll('\u0000', ''));
    found.push({ tool: match[1], words });
  }
  return found;
}

function selfMatching(command) {
  for (const { tool, words } of invocations(command)) {
    let full = false;
    let pattern = null;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.startsWith('-') && !w.startsWith('--') && w.length > 1) {
        const letters = w.slice(1);
        if (letters.includes('f')) full = true;
        if (TAKES_VALUE.has(letters.at(-1))) i++;
        continue;
      }
      pattern = w;
      break;
    }
    if (full && pattern !== null && !pattern.startsWith('[')) return { tool, pattern };
  }
  return null;
}

function unboundedLoop(command) {
  if (!/\b(until|while)\b[\s\S]*\bdo\b[\s\S]*\bsleep\b/.test(command)) return false;
  return !/\bg?timeout\b|\bSECONDS\b|-(ge|gt|le|lt)\b|\(\(/.test(command);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const command = input?.tool_input?.command;
if (typeof command !== 'string') process.exit(0);

const problems = [];
const hit = selfMatching(command);
if (hit) {
  const bracketed = `[${hit.pattern[0]}]${hit.pattern.slice(1)}`;
  problems.push(
    `\`${hit.tool} -f '${hit.pattern}'\` also matches every shell whose command line holds the pattern — ` +
      `each command runs as \`zsh -c '…'\`, so other waiting loops match (on Linux, even its own shell). ` +
      `Two such loops waited on each other for hours. Wait for a background command with ` +
      `run_in_background and its completion notice, or on a concrete PID (\`while kill -0 $PID && [ $SECONDS -lt 900 ]; do sleep 5; done\`), or use ` +
      `the bracket form \`${hit.tool} -f '${bracketed}'\` plus something only your worktree has, such as ` +
      `its port: parallel worktrees run the same commands.`,
  );
}
if (unboundedLoop(command)) {
  problems.push(
    'This `until`/`while` loop sleeps with no bound, so it polls forever if its condition never ' +
      'turns. Bound it: `timeout 900 zsh -c \'…\'`, `until cond || [ $SECONDS -gt 900 ]; do sleep 5; done`, ' +
      'or a counter. Better still, run the long command with run_in_background and wait for its notice.',
  );
}
if (problems.length > 0) {
  process.stderr.write(`Blocked by .claude/hooks/guard-wait.mjs:\n- ${problems.join('\n- ')}\n`);
  process.exit(2);
}

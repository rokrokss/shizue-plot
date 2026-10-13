/**
 * A Lua child gone bad, for the parent's side of the protocol: it says it
 * booted, and then answers each call as the call's `code` names — `llm`,
 * `request`, `similarity` or `lore` asks for what no `editRequest` listener has,
 * `garbage` writes a line that is not JSON, `flood` a line past the limit,
 * `stray` a `done` for a call never made. Whatever the parent replies is
 * written back as the request, so a test can see one was sent.
 */
const write = (message: unknown): boolean => process.stdout.write(`${JSON.stringify(message)}\n`);
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  pending += chunk;
  for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
    const message = JSON.parse(pending.slice(0, end)) as Record<string, unknown>;
    pending = pending.slice(end + 1);
    if (message['type'] === 'program') write({ type: 'booted' });
    if (message['type'] === 'reply') write({ type: 'done', call: 1, result: { res: [{ role: 'user', content: JSON.stringify(message) }] } });
    if (message['type'] !== 'call') continue;
    const code = message['code'];
    if (code === 'garbage') process.stdout.write('not json\n');
    else if (code === 'flood') process.stdout.write('x'.repeat(9 * 1024 * 1024));
    else if (code === 'stray') write({ type: 'done', call: 7, result: {} });
    else write({ type: 'host', call: message['call'], host: 1, name: code, args: { url: 'https://example.com', messages: [] } });
  }
});
process.stdin.on('end', () => process.exit(0));

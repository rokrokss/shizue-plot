/**
 * Whether this Node keeps a child off the network (`requestLua.ts`). Spawned
 * once at startup with the Lua child's own flags, it asks for a name and for a
 * socket, and prints whether the permission model refused each. Node's
 * permission model controls the network only from 25 on: an older one answers
 * the lookup, or does not know the flags at all, and either way the server
 * runs no card's Lua.
 *
 * Erasable TypeScript importing only `node:` modules, as the child is.
 */
import dns from 'node:dns';
import net from 'node:net';

const denied = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_ACCESS_DENIED';

const lookup = new Promise<boolean>((resolve) => {
  try {
    dns.lookup('localhost', (error) => resolve(denied(error)));
  } catch (error) {
    resolve(denied(error));
  }
});

// The discard port on this machine: where the network is open, refused or answered at once.
const connect = new Promise<boolean>((resolve) => {
  try {
    const socket = net.connect({ host: '127.0.0.1', port: 9 });
    socket.on('error', (error) => resolve(denied(error)));
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
  } catch (error) {
    resolve(denied(error));
  }
});

void Promise.all([lookup, connect]).then(([lookupDenied, connectDenied]) => {
  process.stdout.write(`${JSON.stringify({ lookupDenied, connectDenied })}\n`);
});

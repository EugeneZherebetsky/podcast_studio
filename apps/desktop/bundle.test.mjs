import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startServer } from './supervisor.mjs';

test('bundled child binds its own loopback port and reports readiness over IPC', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'podcast-desktop-d4-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  const resources = path.resolve('dist-desktop');
  const rogue = net.createServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nrogue'));
  await new Promise((resolve, reject) => rogue.listen(0, '127.0.0.1', resolve).once('error', reject));
  const occupiedPort = rogue.address().port;
  let exitCode;
  const server = startServer(resources, home, (code) => { exitCode = code; });
  try {
    const port = await server.ready;
    assert.notEqual(port, occupiedPort);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html/i);
  } finally { await server.stop(); rogue.close(); }
  assert.equal(exitCode, 0);
});

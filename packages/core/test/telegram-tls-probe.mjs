// Local TLS origin offers BOTH h2 and HTTP/1.1; a TCP proxy can silently blackhole an existing connection.
// No real Telegram calls or credentials. Also runnable with `soak [rounds]` for repeated abort/recovery cycles.
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import net from 'node:net';
import fs from 'node:fs';
import { once } from 'node:events';
import { TelegramApi, TelegramApiError, TelegramNetworkError } from '../dist/telegram.js';

const scenario = process.argv[2];
const sockets = new Set();
const sessions = new Set();
const versions = new Set();
let requests = 0;
let downloadClosed;
const downloadWasClosed = new Promise(resolve => { downloadClosed = resolve; });
const server = http2.createSecureServer({
  // Ключ и сертификат localhost создаёт тест на время прогона (в репозитории ключей нет).
  key: fs.readFileSync(process.env.STG_TLS_KEY),
  cert: fs.readFileSync(process.env.STG_TLS_CERT),
  allowHTTP1: true,
});
server.on('session', session => {
  sessions.add(session);
  session.on('error', () => {});
  session.on('close', () => sessions.delete(session));
});
server.on('request', (req, res) => {
  requests++;
  versions.add(req.httpVersion);
  req.resume();
  res.on('error', () => {});
  if (req.url.endsWith('/missing')) {
    res.writeHead(404);
    res.write('file not found');
    // Deliberately unfinished error body: the client must cancel it without waiting for EOF/GC/a timeout.
    res.on('close', downloadClosed);
  } else if (req.url.endsWith('/file.txt')) {
    res.end('file contents');
  } else if (req.url.endsWith('/badJson')) {
    res.end('not json');
  } else if (req.url.endsWith('/limited')) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error_code: 429, description: 'retry later', parameters: { retry_after: 3 } }));
  } else {
    res.end(JSON.stringify({ ok: true, result: [] }));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');

let blackhole = false;
const proxy = net.createServer(client => {
  const upstream = net.connect(server.address().port, '127.0.0.1');
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  }
  let dead = false;
  // Existing connections stay dead after the network recovers; only a NEW connection can work.
  client.on('data', data => { dead ||= blackhole; if (!dead) upstream.write(data); });
  upstream.on('data', data => { dead ||= blackhole; if (!dead) client.write(data); });
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
});
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');
const api = new TelegramApi(`https://localhost:${proxy.address().port}`, 'test-token');
const stop = new AbortController();
async function poll(timeoutMs = 2000) {
  // Same cancellation shape as Reception: one per-poll controller plus the persistent stop signal.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('poll timeout')), timeoutMs);
  try {
    return await api.call('getUpdates', {}, { signal: AbortSignal.any([stop.signal, ctl.signal]) });
  } finally {
    clearTimeout(timer);
  }
}

try {
  assert.deepEqual(await poll(), []);
  if (scenario === 'download-cancel') {
    await assert.rejects(api.download('missing'), err => err instanceof TelegramApiError && err.errorCode === 404);
    await downloadWasClosed;
    assert.equal((await api.download('file.txt', { timeoutMs: 2000 })).toString(), 'file contents');
  } else {
    const rounds = scenario === 'soak' ? Number(process.argv[3] ?? 1000) : 3;
    const samples = [];
    let peakRss = 0;
    let peakSockets = 0;
    for (let i = 0; i < rounds; i++) {
      blackhole = true;
      await assert.rejects(poll(scenario === 'soak' ? 10 : 100), TelegramNetworkError);
      blackhole = false;
      assert.deepEqual(await poll(), [], `poll ${i}: network recovered but the client reused a dead connection`);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      peakSockets = Math.max(peakSockets, sockets.size);
      assert.ok(sockets.size <= 16, `connection pool grew to ${sockets.size} proxy sockets`);
      if (scenario === 'soak' && (i + 1) % 100 === 0) {
        const m = process.memoryUsage();
        samples.push({ round: i + 1, rss_mb: Math.round(m.rss / 1048576), heap_mb: Math.round(m.heapUsed / 1048576), sockets: sockets.size });
        if (m.rss > 512 * 1048576) throw new Error('soak stopped: RSS exceeded 512 MiB');
      }
    }
    if (scenario === 'soak') {
      console.log(JSON.stringify({ ok: true, node: process.version, rounds, requests, peak_rss_mb: Math.round(peakRss / 1048576), peakSockets, samples }));
    } else {
      assert.deepEqual(await api.callMultipart('sendDocument', { chat_id: 1 }, {
        document: { data: Buffer.from('test'), filename: 'test.txt', contentType: 'text/plain' },
      }, { timeoutMs: 2000 }), []);
      assert.equal((await api.download('file.txt', { timeoutMs: 2000 })).toString(), 'file contents');
      await assert.rejects(api.call('badJson', {}, { timeoutMs: 2000 }), TelegramNetworkError);
      await assert.rejects(api.call('limited', {}, { timeoutMs: 2000 }), err => err instanceof TelegramApiError && err.retryAfter === 3);
      assert.deepEqual([...versions], ['1.1'], 'all Telegram methods must use HTTP/1.1 even when the server offers h2');
    }
  }
  if (scenario !== 'soak') console.log(JSON.stringify({ ok: true, requests, versions: [...versions] }));
} finally {
  stop.abort();
  for (const socket of sockets) socket.destroy();
  for (const session of sessions) session.destroy();
  server.closeAllConnections?.();
  await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => server.close(resolve))]);
}

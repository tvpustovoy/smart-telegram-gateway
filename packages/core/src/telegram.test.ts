import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const probe = fileURLToPath(new URL('../test/telegram-tls-probe.mjs', import.meta.url));
let dir = '';
let key = '';
let cert = '';

// Самоподписанный сертификат localhost — на время прогона, во временном каталоге: ключей в репозитории нет.
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-tls-'));
  key = path.join(dir, 'key.pem');
  cert = path.join(dir, 'cert.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert]);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Отдельный процесс: NODE_EXTRA_CA_CERTS читается при старте Node. Проверка сертификатов остаётся включённой.
for (const scenario of ['recovery', 'download-cancel']) {
  it(`Telegram TLS · ${scenario}`, { timeout: 25_000 }, async () => {
    const { stdout } = await run(process.execPath, [probe, scenario], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, STG_TLS_KEY: key, STG_TLS_CERT: cert },
      timeout: 20_000,
    });
    assert.equal(JSON.parse(stdout).ok, true);
  });
}

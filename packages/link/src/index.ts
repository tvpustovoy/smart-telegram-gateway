#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// stg-link — связь шлюза с другими агентами через сеть агентов (TECH-SPEC 5.19). Отдельный процесс: шлюз работает и без него,
// письма тогда ждут в базе. Сеть подключается модулем порта (port.ts); имя шлюза в сети своё и заводится заранее.
//
//   STG_HOME=<каталог бота> stg-link --port <модуль порта> --identity <имя в сети>
//
// stderr — журнал. SIGTERM или Ctrl-C — соединения закрываются, процесс выходит. Обычно связь запускает сам шлюз (раздел
// `link` в config.yaml) и передаёт свой pid в STG_LINK_PARENT: шлюз пропал — связь выходит сама.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveHome, stgPaths } from 'stg-core';
import { LINK_ADAPTER, PeerLink } from './link.js';
import { loadPort } from './port.js';

export { DEFAULT_LINK_TIMING, LINK_ADAPTER, PeerLink, letterText, type LinkOptions, type LinkTiming } from './link.js';
export { loadPort, type Letter, type NetworkPort, type OpenPort, type PortOptions, type SendVerdict } from './port.js';

const USAGE = `stg-link — связь smart-telegram-gateway с другими агентами

  STG_HOME=<каталог бота> stg-link --port <модуль порта> --identity <имя в сети>

  --port       файл модуля с функцией openPort: подключение к сети агентов
  --identity   имя шлюза в сети, заведённое заранее
`;

const PARENT_CHECK_MS = 5_000;

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${LINK_ADAPTER}: ${line}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { port: { type: 'string' }, identity: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help || !values.port || !values.identity) {
    process.stderr.write(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  const paths = stgPaths(resolveHome(process.env));
  const open = await loadPort(values.port);
  const port = await open({ identity: values.identity, home: paths.home });
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  // Запущена шлюзом: шлюз пропал (процесс усыновил launchd) — выходим, сиротой не остаёмся.
  const parent = Number(process.env.STG_LINK_PARENT);
  if (Number.isInteger(parent) && parent > 1) {
    const watch = setInterval(() => {
      if (process.ppid === parent) return;
      log('шлюз пропал — выхожу');
      stop.abort();
    }, PARENT_CHECK_MS);
    watch.unref();
    stop.signal.addEventListener('abort', () => clearInterval(watch), { once: true });
  }
  log(`имя ${values.identity} занято, сокет ${paths.socket}`);
  await new PeerLink({ socketPath: paths.socket, home: paths.home, port, log }).run(stop.signal);
  await port.close();
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    log(`не запустился: ${(err as Error).message}`);
    process.exit(1);
  });
}

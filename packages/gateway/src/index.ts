#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --max-old-space-size=128 --max-semi-space-size=4
// stg-gateway — служба шлюза. Запуск: STG_HOME=<каталог бота> node <GATEWAY_NODE_FLAGS> packages/gateway/dist/index.js
// (флаги — stg-core/version.ts: предел кучи держит память ≤ 200 МБ, N-2).

import { main } from './main.js';

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`stg-gateway: не стартовал: ${(err as Error).message}\n`);
    process.exit(1);
  },
);

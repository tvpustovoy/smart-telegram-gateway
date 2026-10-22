// Посылки (0.3.3, TECH-SPEC 5.16) — модульно, на ParcelService без процесса шлюза: гонка «проверка — чтение» (находка
// проверки) через точки теста между проверкой пути и открытием и между проверками по дескриптору и сверкой пути;
// файл, который дописывают во время чтения; куда можно (личка владельца, группа по номеру с parcels: true, лички
// участников через правило «личка»). Интеграционно — test/e2e m8-parcels.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { openForGateway, sql, type Rules } from 'stg-core';
import type { Ctx } from './context.js';
import { ParcelService, TelegramTarget, type DeliveryRequest, type ParcelHooks } from './parcels.js';

const OWNER = 1001;
const dirs: string[] = [];
after(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

const RULES: Rules = {
  subjects: [],
  chats: [
    { chat: 'private', space: 'личное', role: 'личный ассистент' },
    { chat: -100700, space: 'семья', role: 'личный ассистент', parcels: true },
    { chat: -100800, space: 'работа', role: 'личный ассистент' },
  ],
};

function fresh(rules: Rules = RULES) {
  const home = tmp('stg-parcels-home-');
  const root = tmp('stg-parcels-root-');
  const outside = tmp('stg-parcels-out-');
  const parcels = path.join(root, 'parcels');
  fs.mkdirSync(parcels);
  const { db } = openForGateway(path.join(home, 'gateway.db'));
  const ctx = {
    db,
    clock: { now: () => 1_000_000 },
    config: { owner_id: OWNER, parcels: { dir: parcels, targets: ['telegram'] } },
    paths: { home, raw: path.join(home, 'raw') },
    directory: { rules },
    env: {},
    test: true,
  } as unknown as Ctx;
  const put = (rel: string, content: string): string => {
    const f = path.join(parcels, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    return f;
  };
  const req = (chatId = OWNER): DeliveryRequest => ({ seq: null, chatId, threadId: null, caption: '', fromName: null, turn: 1, held: false });
  const service = (hooks: Partial<ParcelHooks> = {}) => new ParcelService(ctx, { fileIo: () => undefined, ...hooks });
  const deliveries = (): number => (sql(db, 'SELECT count(*) AS n FROM deliveries').get() as { n: number }).n;
  const copies = (): string[] => {
    const store = path.join(home, 'raw', 'parcels');
    return fs.existsSync(store) ? fs.readdirSync(store) : [];
  };
  return { db, ctx, parcels, outside, put, req, service, deliveries, copies };
}

describe('посылки (0.3.3): гонка «проверка — чтение» и куда можно — модульно', () => {
  it('без подмены — уходит: доставка pending, копия по SHA-256 (точки теста ничего не ломают)', () => {
    const t = fresh();
    try {
      t.put('отчёт/a.txt', 'содержимое');
      const r = t.service({ beforeOpen: () => undefined, beforeRecheck: () => undefined }).send({ path: 'отчёт/a.txt', target: undefined, leaseCwd: null, req: t.req(), idem: null });
      assert.ok(r.ok, JSON.stringify(r));
      assert.equal(t.deliveries(), 1);
      assert.equal(t.copies().length, 1);
    } finally {
      t.db.close();
    }
  });

  it('звено пути подменили ссылкой наружу между проверкой и открытием — «подменили» (changed): открыт чужой файл, но путь уже не тот', () => {
    const t = fresh();
    try {
      t.put('отчёт/a.txt', 'своё');
      fs.writeFileSync(path.join(t.outside, 'a.txt'), 'чужое: секрет');
      const dir = path.join(t.parcels, 'отчёт');
      const r = t.service({
        beforeOpen: () => {
          fs.renameSync(dir, `${dir}.orig`);
          fs.symlinkSync(t.outside, dir);
        },
      }).send({ path: 'отчёт/a.txt', target: undefined, leaseCwd: null, req: t.req(), idem: null });
      assert.ok(!r.ok && r.reason === 'changed', JSON.stringify(r));
      assert.equal(t.deliveries(), 0);
      assert.deepEqual(t.copies().filter((f) => !f.startsWith('.')), [], 'чужое не скопировано');
    } finally {
      t.db.close();
    }
  });

  it('подменили, а после проверок по дескриптору вернули папку и положили в неё жёсткую ссылку на открытый чужой файл — повторный fstat ловит второе имя', () => {
    const t = fresh();
    try {
      t.put('отчёт/a.txt', 'своё');
      const foreign = path.join(t.outside, 'a.txt');
      fs.writeFileSync(foreign, 'чужое: секрет');
      const dir = path.join(t.parcels, 'отчёт');
      const r = t.service({
        beforeOpen: () => {
          fs.renameSync(dir, `${dir}.orig`);
          fs.symlinkSync(t.outside, dir);
        },
        beforeRecheck: () => {
          // Путь снова ведёт в папку посылок, и по нему — тот же inode, что открыт: realpath и lstat сходятся.
          fs.rmSync(dir);
          fs.mkdirSync(dir);
          fs.linkSync(foreign, path.join(dir, 'a.txt'));
        },
      }).send({ path: 'отчёт/a.txt', target: undefined, leaseCwd: null, req: t.req(), idem: null });
      assert.ok(!r.ok && r.reason === 'changed', JSON.stringify(r));
      assert.equal(t.deliveries(), 0);
      assert.deepEqual(t.copies().filter((f) => !f.startsWith('.')), [], 'чужое не скопировано');
    } finally {
      t.db.close();
    }
  });

  it('файл дописали после проверки по дескриптору — «менялся во время чтения» (changed), обрезок не уходит, временной копии нет', () => {
    const t = fresh();
    try {
      const f = t.put('отчёт/log.txt', 'начало\n');
      const r = t.service({ beforeRecheck: () => fs.appendFileSync(f, 'ещё строка\n') }).send({ path: 'отчёт/log.txt', target: undefined, leaseCwd: null, req: t.req(), idem: null });
      assert.ok(!r.ok && r.reason === 'changed' && /менялся во время чтения/.test(r.text), JSON.stringify(r));
      assert.equal(t.deliveries(), 0);
      assert.deepEqual(t.copies(), [], 'ни копии, ни временного файла');
    } finally {
      t.db.close();
    }
  });

  it('куда можно: личка владельца — всегда; группа по номеру — только с parcels: true; лички участников — только через parcels: true у правила «личка»', () => {
    const t = fresh();
    try {
      const tg = new TelegramTarget(t.ctx);
      assert.equal(tg.check(OWNER), null);
      assert.equal(tg.check(-100700), null, 'группа с parcels: true');
      assert.match(tg.check(-100800) ?? '', /только в личку владельца/);
      assert.match(tg.check(2002) ?? '', /только в личку владельца/, 'личка участника без поля');
      t.put('семья/план.md', '# план');
      const r = t.service().send({ path: 'семья/план.md', target: undefined, leaseCwd: null, req: t.req(-100700), idem: null });
      assert.ok(r.ok, JSON.stringify(r));
      assert.equal((sql(t.db, 'SELECT chat_id FROM deliveries').get() as { chat_id: number }).chat_id, -100700);
      const no = t.service().send({ path: 'семья/план.md', target: undefined, leaseCwd: null, req: t.req(-100800), idem: null });
      assert.ok(!no.ok && no.reason === 'chat');
    } finally {
      t.db.close();
    }
    const open = fresh({ ...RULES, chats: RULES.chats.map((c) => (c.chat === 'private' ? { ...c, parcels: true } : c)) });
    try {
      assert.equal(new TelegramTarget(open.ctx).check(2002), null, 'parcels: true у «лички» — лички всех участников');
    } finally {
      open.db.close();
    }
  });
});

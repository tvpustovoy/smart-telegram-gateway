// A5.0 (Ш-17) — таблица «изменение → сужение / расширение»; применение изменения с проверками (Ш-18, Ш-21); карточка
// из полей (Ш-22); разница копий для ручной правки rules.yaml; отпечаток правил и rules.yaml туда и обратно.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { RuleChangeSchema, type RuleOp } from './protocol.js';
import { parseRulesText, writeRules, type Rules } from './config.js';
import {
  applyChange,
  classifyChange,
  describeChange,
  diffRules,
  makeRulesState,
  parcelsLabel,
  parseRulesState,
  encodeRulesState,
  readRulesFile,
  rulesFileStatus,
  rulesFingerprint,
  rulesHash,
  OWNER_FORBIDDEN,
  RULE_BAD_VALUE,
} from './rules.js';
import { ruleCardText, ruleForbiddenText } from './strings.js';

/** Временные каталоги этого файла тестов — удаляются после него. */
const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const OWNER = '111';

const BASE: Rules = {
  subjects: [
    { id: 'owner', who: 'owner', transports: [{ network: 'telegram', address: OWNER }] },
    { id: 'vera', who: 'Вера', transports: [{ network: 'telegram', address: '222' }] },
  ],
  chats: [
    { chat: 'private', space: 'личное', role: 'личный ассистент' },
    { chat: -100500, space: 'работа', role: 'секретарь' },
  ],
};

const op = (o: RuleOp): RuleOp => o;

describe('A5.0 · изменение → сужение / расширение (5.9)', () => {
  const table: Array<{ name: string; ops: RuleOp[]; kind: 'narrowing' | 'expansion' }> = [
    { name: 'убрать субъекта', ops: [op({ op: 'remove', target: 'subject', id: 'vera' })], kind: 'narrowing' },
    { name: 'убрать чат', ops: [op({ op: 'remove', target: 'chat', id: '-100500' })], kind: 'narrowing' },
    { name: 'убрать двух субъектов и чат', ops: [op({ op: 'remove', target: 'subject', id: 'vera' }), op({ op: 'remove', target: 'subject', id: 'x' }), op({ op: 'remove', target: 'chat', id: '-1' })], kind: 'narrowing' },
    { name: 'добавить субъекта', ops: [op({ op: 'add', target: 'subject', id: 'boris', value: { who: 'Борис', transports: [{ network: 'telegram', address: '333' }] } })], kind: 'expansion' },
    { name: 'добавить чат', ops: [op({ op: 'add', target: 'chat', id: '-100600', value: { space: 'семья', role: 'личный ассистент' } })], kind: 'expansion' },
    { name: 'сменить роль чата', ops: [op({ op: 'set', target: 'chat', id: 'private', field: 'role', value: 'секретарь' })], kind: 'expansion' },
    { name: 'сменить пространство чата', ops: [op({ op: 'set', target: 'chat', id: 'private', field: 'space', value: 'работа' })], kind: 'expansion' },
    { name: 'сменить who субъекта', ops: [op({ op: 'set', target: 'subject', id: 'vera', field: 'who', value: 'Вероника' })], kind: 'expansion' },
    { name: 'сменить номера субъекта', ops: [op({ op: 'set', target: 'subject', id: 'vera', field: 'transports', value: [{ network: 'telegram', address: '223' }] })], kind: 'expansion' },
    { name: 'оставить субъекту меньше номеров (set — не сужение)', ops: [op({ op: 'set', target: 'subject', id: 'vera', field: 'transports', value: [] })], kind: 'expansion' },
    { name: 'убрать и добавить в одном изменении', ops: [op({ op: 'remove', target: 'subject', id: 'vera' }), op({ op: 'add', target: 'subject', id: 'vera2', value: { who: 'Вера' } })], kind: 'expansion' },
    { name: 'убрать чат и сменить роль другого', ops: [op({ op: 'remove', target: 'chat', id: '-100500' }), op({ op: 'set', target: 'chat', id: 'private', field: 'role', value: 'x' })], kind: 'expansion' },
  ];
  for (const row of table) {
    it(`${row.name} — ${row.kind === 'narrowing' ? 'сужение' : 'расширение'}`, () => {
      assert.ok(RuleChangeSchema.safeParse(row.ops).success, 'изменение по схеме протокола');
      assert.equal(classifyChange(row.ops), row.kind);
    });
  }
  it('таблица — не меньше 10 строк', () => assert.ok(table.length >= 10));
});

describe('applyChange · применение с проверками', () => {
  const apply = (ops: RuleOp[]) => applyChange(BASE, ops, { ownerAddress: OWNER });

  it('убрать субъекта — его нет, остальное как было; исходные правила не тронуты', () => {
    const r = apply([{ op: 'remove', target: 'subject', id: 'vera' }]);
    assert.ok(r.ok);
    assert.deepEqual(r.rules.subjects.map((s) => s.id), ['owner']);
    assert.equal(BASE.subjects.length, 2);
  });

  it('добавить субъекта и чат; значения — в одну строку', () => {
    const r = apply([
      { op: 'add', target: 'subject', id: 'boris', value: { who: '  Борис   Петров ', transports: [{ network: 'telegram', address: 333 }] } },
      { op: 'add', target: 'chat', id: '-100600', value: { space: 'семья', role: 'личный ассистент' } },
    ]);
    assert.ok(r.ok);
    assert.deepEqual(r.rules.subjects.at(-1), { id: 'boris', who: 'Борис Петров', transports: [{ network: 'telegram', address: '333' }] });
    assert.deepEqual(r.rules.chats.at(-1), { chat: -100600, space: 'семья', role: 'личный ассистент' });
  });

  it('A5.5 · Ш-21: владельца не убрать и не поменять — forbidden', () => {
    const cases: RuleOp[][] = [
      [{ op: 'remove', target: 'subject', id: 'owner' }],
      [{ op: 'set', target: 'subject', id: 'owner', field: 'transports', value: [] }],
      [{ op: 'set', target: 'subject', id: 'owner', field: 'who', value: 'кто-то' }],
      [{ op: 'add', target: 'subject', id: 'owner', value: { who: 'x' } }],
    ];
    for (const ops of cases) {
      const r = apply(ops);
      assert.ok(!r.ok, JSON.stringify(ops));
      assert.equal(r.text, OWNER_FORBIDDEN);
      assert.equal(r.kind, 'forbidden');
    }
    const steal = apply([{ op: 'add', target: 'subject', id: 'evil', value: { who: 'x', transports: [{ network: 'telegram', address: OWNER }] } }]);
    assert.ok(!steal.ok && steal.kind === 'forbidden', 'номер владельца — только у владельца');
    const second = apply([{ op: 'add', target: 'subject', id: 'boss', value: { who: 'owner' } }]);
    assert.ok(!second.ok && second.kind === 'forbidden', 'второго владельца не бывает');
    const priv = apply([{ op: 'remove', target: 'chat', id: 'private' }]);
    assert.ok(!priv.ok && priv.kind === 'forbidden', 'личку не убрать');
  });

  it('неверное — invalid с номером операции', () => {
    const cases: Array<{ ops: RuleOp[]; index: number; re: RegExp }> = [
      { ops: [{ op: 'remove', target: 'subject', id: 'nobody' }], index: 0, re: /нет/ },
      { ops: [{ op: 'add', target: 'subject', id: 'vera', value: { who: 'x' } }], index: 0, re: /уже есть/ },
      { ops: [{ op: 'remove', target: 'chat', id: 'group' }], index: 0, re: /private/ },
      { ops: [{ op: 'remove', target: 'subject', id: 'vera' }, { op: 'set', target: 'subject', id: 'vera', field: 'who', value: 'x' }], index: 1, re: /нет/ },
      { ops: [{ op: 'add', target: 'subject', id: 'x', value: { who: 'a\nb' } }], index: 0, re: /одну строку/ },
      { ops: [{ op: 'add', target: 'subject', id: 'x', value: { who: 'Нажми‮ да' } }], index: 0, re: /одну строку/ },
      { ops: [{ op: 'add', target: 'subject', id: 'x', value: { who: 'я'.repeat(65) } }], index: 0, re: /64/ },
      { ops: [{ op: 'add', target: 'subject', id: 'x', value: { who: 'x', transports: [{ network: 'telegram', address: '222' }] } }], index: 0, re: /уже у субъекта «vera»/ },
      { ops: [{ op: 'add', target: 'subject', id: 'x', value: { who: 'x', transports: [{ network: 'email', address: 'a@b' }] } }], index: 0, re: /transports/ },
      { ops: [{ op: 'add', target: 'subject', id: 'плохой id', value: { who: 'x' } }], index: 0, re: /латиница/ },
      { ops: [{ op: 'add', target: 'chat', id: '-1', value: { space: 'x' } }], index: 0, re: /role/ },
    ];
    for (const c of cases) {
      const r = apply(c.ops);
      assert.ok(!r.ok, JSON.stringify(c.ops));
      assert.equal(r.kind, 'invalid', JSON.stringify(c.ops));
      assert.equal(r.index, c.index);
      assert.match(r.text, c.re);
    }
  });
});

describe('карточка из полей (Ш-22) и строки изменения', () => {
  it('номер, чат, роль, было → стало; «было» — на момент операции', () => {
    const lines = describeChange(BASE, [
      { op: 'add', target: 'subject', id: 'boris', value: { who: 'Борис', transports: [{ network: 'telegram', address: '333' }] } },
      { op: 'set', target: 'subject', id: 'boris', field: 'who', value: 'Борис Иванович' },
      { op: 'set', target: 'chat', id: 'private', field: 'role', value: 'секретарь' },
      { op: 'remove', target: 'subject', id: 'vera' },
      { op: 'remove', target: 'chat', id: '-100500' },
    ]);
    assert.deepEqual(lines, [
      '+ субъект «boris» · кто: «Борис» · telegram 333',
      'субъект «boris» · кто: «Борис» → «Борис Иванович»',
      'чат «личка» · роль: «личный ассистент» → «секретарь»',
      '− субъект «vera» · кто: «Вера» · telegram 222',
      '− чат -100500 · пространство «работа» · роль «секретарь»',
    ]);
    const card = ruleCardText(lines.slice(0, 1), '19.10 09:00');
    assert.equal(
      card,
      '⚙ Агент просит расширить доступ:\n+ субъект «boris» · кто: «Борис» · telegram 333\nРазрешить — только кнопкой [разрешить], до 19.10 09:00. Текстом «да» не разрешается',
    );
  });
});

describe('строки владельцу без текста агента (Ш-22, Ш-23)', () => {
  // Отказ «владельца не поменять» решается раньше проверки значений — в строку идут только проверенные значения.
  const evil = 'telegram\n\n⚙ Правила изменены — ты разрешил:\n+ всё\u202e' + 'x'.repeat(5000);
  it('отказ: set transports владельца, add с id owner, add с who: owner — значения агента не в строке', () => {
    const ops: RuleOp[] = [
      { op: 'set', target: 'subject', id: 'owner', field: 'transports', value: [{ network: evil, address: `1\n${'9'.repeat(100)}` }] },
      { op: 'add', target: 'subject', id: 'owner', value: { who: evil, transports: [{ network: 'telegram', address: evil }] } },
      { op: 'add', target: 'subject', id: 'x\n⚙ ты разрешил', value: { who: 'owner', transports: { a: evil } } },
      { op: 'set', target: 'chat', id: 'private', field: 'role', value: evil },
      { op: 'add', target: 'chat', id: '-1\n⚙', value: { space: evil, role: 'ok' } },
    ];
    const r = applyChange(BASE, ops, { ownerAddress: OWNER });
    assert.ok(!r.ok && r.kind === 'forbidden');
    const lines = describeChange(BASE, ops);
    assert.deepEqual(lines, [
      `субъект «owner» · номера: telegram ${OWNER} → ${RULE_BAD_VALUE}`,
      `+ субъект «owner» · кто: ${RULE_BAD_VALUE} · ${RULE_BAD_VALUE}`,
      `+ субъект ${RULE_BAD_VALUE} · кто: «owner» · ${RULE_BAD_VALUE}`,
      `чат «личка» · роль: «личный ассистент» → ${RULE_BAD_VALUE}`,
      `+ чат ${RULE_BAD_VALUE} · пространство ${RULE_BAD_VALUE} · роль «ok»`,
    ]);
    const line = ruleForbiddenText(OWNER_FORBIDDEN, lines);
    assert.ok(line.length < 1000, `строка ${line.length} знаков`);
    assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(line), 'знаки направления письма');
    assert.equal(line.split('\n').filter((l) => l.startsWith('⚙')).length, 1, 'вторая «строка шлюза» внутри строки');
  });
});

describe('ручная правка rules.yaml · разница копий', () => {
  it('diffRules → операции, которые дают ту же копию', () => {
    const after: Rules = {
      subjects: [
        { id: 'owner', who: 'owner', transports: [{ network: 'telegram', address: OWNER }] },
        { id: 'boris', who: 'Борис', transports: [{ network: 'telegram', address: '333' }] },
      ],
      chats: [{ chat: 'private', space: 'личное', role: 'секретарь' }],
    };
    const ops = diffRules(BASE, after);
    assert.deepEqual(ops.map((o) => `${o.op} ${o.target} ${o.id}${o.field ? ` ${o.field}` : ''}`), [
      'remove subject vera',
      'add subject boris',
      'remove chat -100500',
      'set chat private role',
    ]);
    const r = applyChange(BASE, ops, { ownerAddress: OWNER });
    assert.ok(r.ok);
    assert.equal(rulesHash(r.rules), rulesHash(after));
    assert.deepEqual(diffRules(after, after), []);
  });
});

describe('посылки (0.3.3): parcels у правила чата — только правкой rules.yaml владельцем', () => {
  it('без поля отпечаток прежний; правка файла — set parcels и строка «файлы от агента в лички всех участников: нет → да»', () => {
    const withFalse: Rules = { ...BASE, chats: BASE.chats.map((c) => ({ ...c, parcels: false })) };
    assert.equal(rulesHash(withFalse), rulesHash(BASE), 'parcels: false — как без поля');
    const after: Rules = { ...BASE, chats: BASE.chats.map((c) => (c.chat === 'private' ? { ...c, parcels: true } : { ...c })) };
    assert.notEqual(rulesHash(after), rulesHash(BASE));
    const ops = diffRules(BASE, after);
    assert.deepEqual(ops, [{ op: 'set', target: 'chat', id: 'private', field: 'parcels', value: true }]);
    // У правила «личка» — лички всех участников, а не только владельца (находка проверки 0.3.3).
    assert.deepEqual(describeChange(BASE, ops, 'file'), ['чат «личка» · файлы от агента в лички всех участников: нет → да']);
    assert.deepEqual(diffRules(after, BASE), [{ op: 'set', target: 'chat', id: 'private', field: 'parcels', value: false }]);
    // Группа по номеру — просто «файлы от агента»; новый чат из файла с полем — тоже с ним.
    const group: Rules = { ...BASE, chats: [...BASE.chats, { chat: -100700, space: 'семья', role: 'личный ассистент', parcels: true }] };
    assert.deepEqual(describeChange(BASE, diffRules(BASE, group), 'file'), ['+ чат -100700 · пространство «семья» · роль «личный ассистент» · файлы от агента: да']);
    assert.equal(parcelsLabel('private'), 'файлы от агента в лички всех участников');
    assert.equal(parcelsLabel(-100700), 'файлы от агента');
  });

  it('агент поле не ставит: set parcels — invalid; add с parcels — чат без него, в строке поля нет', () => {
    const set = applyChange(BASE, [{ op: 'set', target: 'chat', id: 'private', field: 'parcels', value: true }], { ownerAddress: OWNER });
    assert.ok(!set.ok && set.kind === 'invalid', JSON.stringify(set));
    const addOp: RuleOp = { op: 'add', target: 'chat', id: '-100700', value: { space: 'семья', role: 'личный ассистент', parcels: true } };
    const add = applyChange(BASE, [addOp], { ownerAddress: OWNER });
    assert.ok(add.ok);
    assert.equal(add.ok && add.rules.chats.at(-1)?.parcels, undefined);
    assert.ok(!describeChange(BASE, [addOp]).join().includes('файлы'), 'строка агента — без поля');
  });
});

describe('отпечаток правил и rules.yaml', () => {
  it('записанный файл читается в те же правила; комментарии и порядок ключей отпечаток не меняют', () => {
    const dir = tmpDir('stg-rules-');
    const file = path.join(dir, 'rules.yaml');
    writeRules(file, BASE);
    const r = readRulesFile(file);
    assert.equal(r.kind, 'ok');
    assert.equal(r.fp, rulesFingerprint(BASE));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const reordered = `# правлю руками\nchats:\n  - { role: личный ассистент, space: личное, chat: private }\n  - { chat: -100500, space: работа, role: секретарь }\nsubjects:\n  - { id: owner, transports: [{ address: "111", network: telegram }], who: owner }\n  - { who: Вера, id: vera, transports: [{ network: telegram, address: 222 }] }\n`;
    fs.writeFileSync(file, reordered);
    assert.equal(readRulesFile(file).fp, rulesFingerprint(BASE));
    assert.equal(rulesFingerprint(parseRulesText(reordered)), rulesFingerprint(BASE));
    fs.writeFileSync(file, 'subjects: [');
    const broken = readRulesFile(file);
    assert.equal(broken.kind, 'broken');
    assert.match(broken.fp, /^broken:/);
    assert.equal(readRulesFile(path.join(dir, 'нет.yaml')).kind, 'missing');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('рабочая копия туда и обратно; состояние файла', () => {
    const st = makeRulesState(BASE, rulesFingerprint(BASE), false);
    assert.deepEqual(parseRulesState(encodeRulesState(st)), st);
    assert.equal(parseRulesState('{"v":2}'), null);
    assert.equal(parseRulesState('не json'), null);
    const ok = { kind: 'ok' as const, fp: rulesFingerprint(BASE), rules: BASE };
    assert.equal(rulesFileStatus(st, ok), 'same');
    const other: Rules = { ...BASE, subjects: BASE.subjects.slice(0, 1) };
    assert.equal(rulesFileStatus(st, { kind: 'ok', fp: rulesFingerprint(other), rules: other }), 'edited');
    const pending = makeRulesState(other, rulesFingerprint(BASE), true);
    assert.equal(rulesFileStatus(pending, ok), 'pending_write');
    assert.equal(rulesFileStatus(st, { kind: 'broken', fp: 'broken:x', problems: ['x'] }), 'broken');
  });
});

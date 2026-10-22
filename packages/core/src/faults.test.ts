import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAULT_POINTS, FaultSpecError, faultMatches, parseFaultSpec } from './faults.js';

const faultsModule = fileURLToPath(new URL('./faults.js', import.meta.url));

/** Дочерний процесс: дойти до точки и, если не вышли, вернуть 0. */
function runPoint(env: Record<string, string>, point: string, updateId?: number): number | null {
  const code = `import(${JSON.stringify(faultsModule)}).then((m) => { m.faultPoint(${JSON.stringify(point)}, ${
    updateId ?? 'undefined'
  }); process.exit(0); });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
  return r.status;
}

describe('точки сбоя', () => {
  it('разбор: точка и необязательный номер обновления', () => {
    assert.deepEqual(parseFaultSpec('after_commit'), { point: 'after_commit', updateId: null });
    assert.deepEqual(parseFaultSpec('in_handler:42'), { point: 'in_handler', updateId: 42 });
    assert.equal(parseFaultSpec(undefined), null);
    assert.equal(parseFaultSpec(''), null);
    assert.throws(() => parseFaultSpec('in_handlr'), FaultSpecError);
    assert.throws(() => parseFaultSpec('in_handler:x'), FaultSpecError);
  });

  it('все точки TECH-SPEC §7 известны', () => {
    assert.deepEqual([...FAULT_POINTS].sort(), [
      'after_commit',
      'after_eyes',
      'after_files',
      'before_files',
      'in_handler',
      'in_send',
      'in_stt',
    ]);
  });

  it('совпадение: без номера — на любом обновлении; с номером — только на нём', () => {
    const any = parseFaultSpec('in_send');
    const one = parseFaultSpec('in_send:7');
    assert.ok(faultMatches(any, 'in_send', 1));
    assert.ok(faultMatches(any, 'in_send'));
    assert.ok(!faultMatches(any, 'in_stt', 1));
    assert.ok(faultMatches(one, 'in_send', 7));
    assert.ok(!faultMatches(one, 'in_send', 8));
    assert.ok(!faultMatches(one, 'in_send'));
  });

  it('при STG_TEST=1 точка даёт выход 137', () => {
    assert.equal(runPoint({ STG_TEST: '1', STG_FAULT: 'after_commit' }, 'after_commit', 5), 137);
    assert.equal(runPoint({ STG_TEST: '1', STG_FAULT: 'in_handler:5' }, 'in_handler', 5), 137);
  });

  it('другая точка, другой номер или нет STG_TEST=1 — выхода нет', () => {
    assert.equal(runPoint({ STG_TEST: '1', STG_FAULT: 'in_handler:5' }, 'in_handler', 6), 0);
    assert.equal(runPoint({ STG_TEST: '1', STG_FAULT: 'in_send' }, 'in_stt', 1), 0);
    assert.equal(runPoint({ STG_FAULT: 'after_commit' }, 'after_commit', 5), 0);
    assert.equal(runPoint({ STG_TEST: '0', STG_FAULT: 'after_commit' }, 'after_commit', 5), 0);
  });
});

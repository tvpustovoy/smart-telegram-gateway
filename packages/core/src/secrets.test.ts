import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  KeychainSecretStore,
  SecretError,
  TestEnvSecretStore,
  keychainAddCommand,
  redactSecrets,
  secretStoreFromEnv,
  testSecretEnv,
  voiceKeyName,
  type CommandRunner,
} from './secrets.js';

describe('секреты (5.1)', () => {
  it('под тестом — только переменные STG_TEST_*; связка ключей не вызывается', async () => {
    let called = false;
    const runner: CommandRunner = async () => {
      called = true;
      return { code: 0, stdout: 'из-связки\n', stderr: '' };
    };
    const s = secretStoreFromEnv({ STG_TEST: '1', STG_TEST_TELEGRAM_TOKEN: '123:abc', STG_TEST_VOICE_KEY_OPENROUTER: 'sk-or-1' }, 'b_bot', runner);
    assert.ok(s instanceof TestEnvSecretStore);
    assert.equal(await s.get('telegram'), '123:abc');
    assert.equal(await s.get(voiceKeyName('elevenlabs')), null);
    assert.equal(await s.get(voiceKeyName('openrouter')), 'sk-or-1');
    assert.equal(called, false);
    assert.equal(s.describe(voiceKeyName('openai')), 'переменная STG_TEST_VOICE_KEY_OPENAI (STG_TEST=1)');
  });

  it('без STG_TEST=1 переменные STG_TEST_* не действуют', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
    };
    const s = secretStoreFromEnv({ STG_TEST_TELEGRAM_TOKEN: '123:abc' }, 'b_bot', runner);
    assert.ok(s instanceof KeychainSecretStore);
    assert.equal(await s.get('telegram'), null);
    assert.deepEqual(calls[0], [
      '/usr/bin/security',
      'find-generic-password',
      '-s',
      'smart-telegram-gateway',
      '-a',
      'b_bot/telegram',
      '-w',
    ]);
  });

  it('связка ключей: учётные записи <bot>/telegram и ключи голоса ровно по имени из config.yaml; перевод строки отрезается', async () => {
    const accounts: string[] = [];
    const runner: CommandRunner = async (_f, args) => {
      accounts.push(args[4] ?? '');
      return { code: 0, stdout: 'секрет\n', stderr: '' };
    };
    const s = new KeychainSecretStore('b_bot', runner);
    assert.equal(await s.get('telegram'), 'секрет');
    for (const k of ['openai', 'elevenlabs', 'openrouter', 'my.Voice-key']) assert.equal(await s.get(voiceKeyName(k)), 'секрет');
    assert.deepEqual(accounts, ['b_bot/telegram', 'openai', 'elevenlabs', 'openrouter', 'my.Voice-key']);
    assert.equal(s.describe(voiceKeyName('openai')), 'связка ключей, служба smart-telegram-gateway, учётная запись openai');
  });

  it('переменная ключа голоса под тестом: STG_TEST_VOICE_KEY_<ИМЯ>', () => {
    assert.equal(testSecretEnv('telegram'), 'STG_TEST_TELEGRAM_TOKEN');
    assert.equal(testSecretEnv(voiceKeyName('openai')), 'STG_TEST_VOICE_KEY_OPENAI');
    assert.equal(testSecretEnv(voiceKeyName('my.Voice-key')), 'STG_TEST_VOICE_KEY_MY_VOICE_KEY');
  });

  it('связка ключей не ответила — SecretError', async () => {
    const runner: CommandRunner = async () => ({ code: 51, stdout: '', stderr: 'User interaction is not allowed.' });
    await assert.rejects(new KeychainSecretStore('b_bot', runner).get('telegram'), SecretError);
  });

  it('команда для владельца — ввод без эха (-w последним)', () => {
    assert.equal(keychainAddCommand('b_bot', 'telegram'), 'security add-generic-password -s smart-telegram-gateway -a b_bot/telegram -w');
    assert.equal(keychainAddCommand('b_bot', voiceKeyName('openai')), 'security add-generic-password -s smart-telegram-gateway -a openai -w');
  });

  it('redactSecrets убирает токен и его вид в адресе', () => {
    const token = '123456:AA-bb_cc';
    const text = `https://api.telegram.org/bot${token}/getMe ${encodeURIComponent(token)}`;
    const out = redactSecrets(text, [token]);
    assert.ok(!out.includes(token));
    assert.ok(!out.includes(encodeURIComponent(token)));
    assert.match(out, /<секрет>/);
  });
});

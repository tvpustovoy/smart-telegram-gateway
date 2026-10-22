// Секреты — одним интерфейсом (TECH-SPEC 5.1): на macOS — связка ключей
// (`security find-generic-password -s smart-telegram-gateway -a <учётная запись> -w`); под тестом (STG_TEST=1) —
// только переменные STG_TEST_TELEGRAM_TOKEN и STG_TEST_VOICE_KEY_<ИМЯ>, связка ключей не трогается.
// Секрет не пишется ни в файлы, ни в журнал: для текстов есть redactSecrets.
//
// Ключи голоса (5.8) — по имени из config.yaml (stt.key, tts.key): учётная запись в связке ключей ровно как задано
// (по умолчанию — имя провайдера: openai, elevenlabs; для OpenRouter владелец пишет key: openrouter).

import { execFile } from 'node:child_process';
import { KEYCHAIN_SERVICE } from './paths.js';

/** Ключ голоса: учётная запись в связке ключей — имя из config.yaml как есть. */
export interface VoiceKeyName {
  readonly voice: string;
}

export type SecretName = 'telegram' | VoiceKeyName;

export function voiceKeyName(account: string): VoiceKeyName {
  return { voice: account };
}

export interface SecretStore {
  readonly source: 'keychain' | 'test-env';
  /** null — секрета нет. Ошибка — связка ключей не ответила. */
  get(name: SecretName): Promise<string | null>;
  /** Где лежит секрет — словами, для «что сделать». */
  describe(name: SecretName): string;
}

export class SecretError extends Error {}

/** Учётная запись в связке ключей: `<bot>/telegram`; ключ голоса — его имя из config.yaml (5.1, 5.8). */
export function keychainAccount(bot: string, name: SecretName): string {
  return name === 'telegram' ? `${bot}/telegram` : name.voice;
}

/** Переменная секрета под тестом: STG_TEST_TELEGRAM_TOKEN; ключ голоса — STG_TEST_VOICE_KEY_<ИМЯ> (верхний регистр, не буквы и цифры — «_»). */
export function testSecretEnv(name: SecretName): string {
  if (name === 'telegram') return 'STG_TEST_TELEGRAM_TOKEN';
  return `STG_TEST_VOICE_KEY_${name.voice.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout, stderr });
    });
  });

/** Код выхода `security`, когда записи нет (errSecItemNotFound). */
const SECURITY_NOT_FOUND = 44;

export class KeychainSecretStore implements SecretStore {
  readonly source = 'keychain' as const;

  constructor(
    private readonly bot: string,
    private readonly run: CommandRunner = runCommand,
    private readonly securityPath = '/usr/bin/security',
  ) {}

  async get(name: SecretName): Promise<string | null> {
    const r = await this.run(this.securityPath, [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      keychainAccount(this.bot, name),
      '-w',
    ]);
    if (r.code === 0) {
      const value = r.stdout.replace(/\r?\n$/, '');
      return value === '' ? null : value;
    }
    if (r.code === SECURITY_NOT_FOUND) return null;
    // Текст ошибки `security` секрета не содержит, но берём только первую строку.
    throw new SecretError(`связка ключей не ответила (код ${r.code ?? 'нет'}): ${r.stderr.split('\n')[0] ?? ''}`.trim());
  }

  describe(name: SecretName): string {
    return `связка ключей, служба ${KEYCHAIN_SERVICE}, учётная запись ${keychainAccount(this.bot, name)}`;
  }
}

export class TestEnvSecretStore implements SecretStore {
  readonly source = 'test-env' as const;

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async get(name: SecretName): Promise<string | null> {
    const v = this.env[testSecretEnv(name)];
    return v ? v : null;
  }

  describe(name: SecretName): string {
    return `переменная ${testSecretEnv(name)} (STG_TEST=1)`;
  }
}

/** Хранилище секретов по окружению: STG_TEST=1 — переменные, иначе связка ключей. */
export function secretStoreFromEnv(env: NodeJS.ProcessEnv, bot: string, run?: CommandRunner): SecretStore {
  return env.STG_TEST === '1' ? new TestEnvSecretStore(env) : new KeychainSecretStore(bot, run);
}

/** Как положить секрет — команда для владельца (ввод без эха: `-w` последним). */
export function keychainAddCommand(bot: string, name: SecretName): string {
  return `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${keychainAccount(bot, name)} -w`;
}

/** Убрать секреты из текста (в том числе в виде из адреса). */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join('<секрет>');
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join('<секрет>');
  }
  return out;
}

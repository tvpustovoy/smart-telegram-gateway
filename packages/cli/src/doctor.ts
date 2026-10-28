// stg doctor (TECH-SPEC 5.13): строка «да / нет / что сделать» на каждую проверку, код выхода ≠ 0 при «нет».
// Ничего не меняет: база — только на чтение, getUpdates не вызывается, связка ключей — только чтение.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  ConfigError,
  HomeError,
  META_KEYS,
  SCHEMA_VERSION,
  SecretError,
  TelegramApi,
  TelegramApiError,
  getMeta,
  inspectDatabase,
  keychainAddCommand,
  launchdLabel,
  loadConfig,
  loadRules,
  nodeVersionOk,
  openDatabase,
  parseRulesState,
  readRulesFile,
  resolveHome,
  rulesFileStatus,
  runCommand,
  schemaVersion,
  secretStoreFromEnv,
  stgPaths,
  sttVocabularyUse,
  testSecretEnv,
  ttsVoice,
  ttsVoiceField,
  ttsVoiceHint,
  voiceKeyName,
  voiceProviderLabel,
  voiceProviderNote,
  type CommandRunner,
  type Config,
  type RulesState,
  type StgPaths,
  type VoiceProviderName,
} from 'stg-core';
import { checkGatewayPlist } from './service.js';

export interface CheckLine {
  ok: boolean;
  name: string;
  detail: string;
  todo?: string;
}

/** Рабочая копия правил из базы (только чтение); базы нет или она старее M5 — null. */
function readRulesStateRo(paths: StgPaths): RulesState | null {
  if (!fs.existsSync(paths.db)) return null;
  try {
    const db = openDatabase(paths.db, { readOnly: true });
    try {
      return schemaVersion(db) >= 4 ? parseRulesState(getMeta(db, META_KEYS.rulesState)) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function formatLine(l: CheckLine): string {
  const head = l.ok ? 'да ' : 'нет';
  return `${head} · ${l.name} · ${l.detail}${!l.ok && l.todo ? ` · что сделать: ${l.todo}` : ''}`;
}

export interface DoctorOptions {
  env: NodeJS.ProcessEnv;
  home?: string;
  /** Запуск внешних команд (launchctl, security) — подменяется в тестах. */
  run?: CommandRunner;
}

const NET_TIMEOUT_MS = 10_000;
/** Меньше — «нет»: при полном диске приём останавливается (5.2). */
const MIN_FREE_BYTES = 1024 ** 3;

function launchAgentsDir(env: NodeJS.ProcessEnv): string {
  if (env.STG_TEST === '1' && env.STG_LAUNCH_AGENTS_DIR) return env.STG_LAUNCH_AGENTS_DIR;
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function launchctlPath(env: NodeJS.ProcessEnv): string {
  // Под тестом — подставной launchctl: настоящий тест не трогает.
  if (env.STG_TEST === '1') return env.STG_LAUNCHCTL || '/usr/bin/false';
  return '/bin/launchctl';
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'адрес не разобрать';
  }
}

/** Версия @modelcontextprotocol/sdk, которую найдёт канал, и закреплённая в его package.json. */
export function channelSdkVersion(): { installed: string | null; pinned: string | null; where: string | null } {
  const require = createRequire(import.meta.url);
  let channelDir: string;
  try {
    channelDir = path.dirname(require.resolve('stg-channel/package.json'));
  } catch {
    return { installed: null, pinned: null, where: null };
  }
  let pinned: string | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(channelDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    pinned = pkg.dependencies?.['@modelcontextprotocol/sdk'] ?? null;
  } catch {
    pinned = null;
  }
  for (let dir = channelDir; ; dir = path.dirname(dir)) {
    const f = path.join(dir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
    if (fs.existsSync(f)) {
      try {
        return { installed: (JSON.parse(fs.readFileSync(f, 'utf8')) as { version?: string }).version ?? null, pinned, where: f };
      } catch {
        return { installed: null, pinned, where: f };
      }
    }
    if (path.dirname(dir) === dir) break;
  }
  return { installed: null, pinned, where: null };
}

function readLastUnknown(paths: StgPaths): { id: number | null; name: string | null } | null {
  if (!fs.existsSync(paths.db)) return null;
  try {
    const db = openDatabase(paths.db, { readOnly: true });
    try {
      const v = getMeta(db, META_KEYS.lastUnknownFrom);
      if (!v) return null;
      const parsed = JSON.parse(v) as { id?: number | null; name?: string | null };
      return { id: parsed.id ?? null, name: parsed.name ?? null };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function runDoctor(opts: DoctorOptions): Promise<{ lines: CheckLine[]; code: number; home: string | null }> {
  const { env } = opts;
  const run = opts.run ?? runCommand;
  const lines: CheckLine[] = [];
  const add = (l: CheckLine): void => {
    lines.push(l);
  };

  let paths: StgPaths;
  try {
    paths = stgPaths(resolveHome(env, opts.home));
  } catch (err) {
    add({
      ok: false,
      name: 'каталог бота',
      detail: err instanceof HomeError ? err.message : String(err),
      todo: 'задай STG_HOME=<каталог бота> или установи шлюз',
    });
    return { lines, code: 1, home: null };
  }

  // 1. Каталог и права.
  if (!fs.existsSync(paths.home)) {
    add({ ok: false, name: 'каталог бота', detail: `нет ${paths.home}`, todo: 'установи шлюз или задай STG_HOME' });
    return { lines, code: 1, home: paths.home };
  }
  add({ ok: true, name: 'каталог бота', detail: paths.home });
  const mode = fs.statSync(paths.home).mode & 0o777;
  add(
    mode === 0o700
      ? { ok: true, name: 'права каталога', detail: '0700' }
      : { ok: false, name: 'права каталога', detail: `0${mode.toString(8)}, нужно 0700`, todo: `chmod 700 ${paths.home}` },
  );

  // 2. Настройки и правила.
  let config: Config | null = null;
  try {
    config = loadConfig(paths.config, { test: env.STG_TEST === '1' });
    add({ ok: true, name: 'настройки', detail: `config.yaml: бот ${config.bot}, пояс ${config.timezone}` });
  } catch (err) {
    const problems = err instanceof ConfigError ? err.problems.join('; ') : String(err);
    add({ ok: false, name: 'настройки', detail: `config.yaml: ${problems}`, todo: `исправь ${paths.config}` });
  }
  try {
    const r = loadRules(paths.rules);
    const st = readRulesStateRo(paths);
    const f = readRulesFile(paths.rules);
    const edited = st !== null && rulesFileStatus(st, f) === 'edited';
    add({
      ok: true,
      name: 'правила',
      detail: r.missing
        ? 'rules.yaml ещё нет — шлюз создаст его при старте'
        : `rules.yaml: субъектов ${r.rules.subjects.length}, чатов ${r.rules.chats.length}${edited ? '; правлен вручную — прочитается при перезапуске шлюза (stg rules show)' : ''}`,
    });
  } catch (err) {
    // Испорченный rules.yaml шлюз не исполняет: держит прежнюю рабочую копию (5.9) — сказано владельцу строкой.
    const problems = err instanceof ConfigError ? err.problems.join('; ') : String(err);
    add({ ok: false, name: 'правила', detail: `rules.yaml: ${problems} — шлюз держит прежние правила`, todo: `исправь ${paths.rules} и перезапусти шлюз` });
  }

  // 3. Владелец — первая настройка (5.3).
  if (config) {
    if (config.owner_id !== null) {
      add({ ok: true, name: 'владелец', detail: `owner_id ${config.owner_id}` });
    } else {
      const last = readLastUnknown(paths);
      add(
        last?.id
          ? {
              ok: false,
              name: 'владелец',
              detail: `owner_id не задан; последним боту писал ${last.id}${last.name ? ` (${last.name})` : ''}`,
              todo: `если это ты — впиши owner_id: ${last.id} в config.yaml и перезапусти шлюз`,
            }
          : {
              ok: false,
              name: 'владелец',
              detail: 'owner_id не задан; боту ещё никто не писал',
              todo: 'напиши боту /start с телефона, затем снова stg doctor',
            },
      );
    }
  }

  // 4. Токен и Telegram.
  let api: TelegramApi | null = null;
  if (config) {
    const store = secretStoreFromEnv(env, config.bot, run);
    let token: string | null = null;
    let tokenError: string | null = null;
    try {
      token = await store.get('telegram');
    } catch (err) {
      tokenError = err instanceof SecretError ? err.message : String(err);
    }
    if (tokenError) {
      add({ ok: false, name: 'токен бота', detail: tokenError, todo: 'разблокируй связку ключей и повтори stg doctor' });
    } else if (!token) {
      add({
        ok: false,
        name: 'токен бота',
        detail: `нет: ${store.describe('telegram')}`,
        todo: store.source === 'keychain' ? keychainAddCommand(config.bot, 'telegram') : 'задай STG_TEST_TELEGRAM_TOKEN',
      });
    } else {
      const candidate = new TelegramApi(config.telegram.api_base, token);
      try {
        const me = await candidate.getMe({ timeoutMs: NET_TIMEOUT_MS });
        api = candidate;
        if (me.username && me.username !== config.bot) {
          add({
            ok: false,
            name: 'токен бота',
            detail: `getMe — @${me.username}, а в config.yaml — ${config.bot}`,
            todo: 'проверь токен у BotFather или поле bot в config.yaml',
          });
        } else {
          add({ ok: true, name: 'токен бота', detail: `есть (${store.source === 'keychain' ? 'связка ключей' : 'переменная теста'}); getMe — @${me.username ?? '?'}` });
        }
      } catch (err) {
        const rejected = err instanceof TelegramApiError && (err.errorCode === 401 || err.errorCode === 404);
        add({
          ok: false,
          name: 'токен бота',
          detail: rejected ? `Telegram не принял токен (${err.errorCode})` : `getMe не прошёл: ${candidate.redact((err as Error).message)}`,
          todo: rejected
            ? `новый токен у BotFather → ${keychainAddCommand(config.bot, 'telegram')} -U`
            : `проверь сеть; telegram.api_base — ${safeHost(config.telegram.api_base)}`,
        });
      }
    }
  }

  // 4а. Голос (5.8): распознавание и синтез — каждый своей строкой: провайдер, адрес, модель, есть ли ключ под именем из
  // config.yaml (сам ключ не печатается); у синтеза — голос. API провайдера doctor не вызывает: запрос платный, а ключ
  // проверяется первым же голосовым (401 — в журнале).
  if (config) {
    const store = secretStoreFromEnv(env, config.bot, run);
    const keys = new Map<string, { present: boolean | null; error: string | null }>();
    const keyOf = async (name: string): Promise<{ present: boolean | null; error: string | null }> => {
      const known = keys.get(name);
      if (known) return known;
      let r: { present: boolean | null; error: string | null };
      try {
        r = { present: (await store.get(voiceKeyName(name))) !== null, error: null };
      } catch (err) {
        r = { present: null, error: err instanceof SecretError ? err.message : String(err) };
      }
      keys.set(name, r);
      return r;
    };
    const where = store.source === 'keychain' ? 'связка ключей' : 'переменная теста';
    const keyTodo = (name: string): string =>
      store.source === 'keychain' ? keychainAddCommand(config.bot, voiceKeyName(name)) : `задай ${testSecretEnv(voiceKeyName(name))}`;
    const voiceLine = async (
      name: string,
      cfg: { provider: VoiceProviderName; base_url: string; model: string; key: string },
      extra: string,
      missing: string,
      problem: { detail: string; todo: string } | null,
    ): Promise<void> => {
      const info = { provider: cfg.provider, baseUrl: cfg.base_url };
      // Оговорка к варианту (OpenRouter): распознавание не проверено на ключе; синтез — заведомо не Ogg/Opus («нет»).
      const note = voiceProviderNote({ ...info, what: name === 'синтез' ? 'tts' : 'stt' });
      const head = `${voiceProviderLabel(info)} (${cfg.provider}), ${cfg.base_url}, модель ${cfg.model}${extra}${note ? ` ⟨${note.text}⟩` : ''}`;
      if (note?.blocking) {
        add({ ok: false, name, detail: head, todo: 'синтез — OpenAI напрямую или ElevenLabs (tts.provider, tts.base_url)' });
        return;
      }
      const k = await keyOf(cfg.key);
      if (k.error) {
        add({ ok: false, name, detail: `${head}; ключ ${cfg.key}: ${k.error}`, todo: 'разблокируй связку ключей и повтори stg doctor' });
        return;
      }
      const todo: string[] = [];
      const detail: string[] = [];
      if (!k.present) {
        detail.push(`ключа ${cfg.key} нет: ${store.describe(voiceKeyName(cfg.key))} — ${missing}`);
        todo.push(keyTodo(cfg.key));
      } else detail.push(`ключ ${cfg.key} — есть (${where})`);
      if (problem) {
        detail.push(problem.detail);
        todo.push(problem.todo);
      }
      add(todo.length ? { ok: false, name, detail: `${head}; ${detail.join('; ')}`, todo: todo.join('; ') } : { ok: true, name, detail: `${head}; ${detail.join('; ')}` });
    };
    const { stt, tts } = config;
    const vocab = sttVocabularyUse(stt);
    await voiceLine(
      'распознавание',
      stt,
      `, язык ${stt.language}, словарь ${vocab.terms}${vocab.note ? ` (${vocab.note})` : ''}`,
      'голосовые не распознаются',
      null,
    );
    const voice = ttsVoice(tts);
    await voiceLine(
      'синтез',
      tts,
      voice ? `, голос ${voice}` : '',
      'ответы голосом уходят текстом',
      voice
        ? null
        : {
            detail: `${ttsVoiceField(tts)} не задан — ответы голосом уходят текстом с пометкой «голос не получился»`,
            todo: `впиши ${ttsVoiceField(tts)} (${ttsVoiceHint(tts)}) в ${paths.config} и перезапусти шлюз`,
          },
    );
  }

  // 5. Вебхук (409, Ш-24): deleteWebhook — только по слову владельца.
  if (config) {
    if (!api) {
      add({ ok: false, name: 'вебхук', detail: 'не проверить без рабочего токена', todo: 'сначала токен (строка выше)' });
    } else {
      try {
        const info = await api.getWebhookInfo({ timeoutMs: NET_TIMEOUT_MS });
        add(
          info.url
            ? {
                ok: false,
                name: 'вебхук',
                detail: `у бота стоит вебхук (${safeHost(info.url)}): опрос получит 409`,
                todo: 'снять вебхук (deleteWebhook, drop_pending_updates=false) — только по слову владельца',
              }
            : { ok: true, name: 'вебхук', detail: 'нет — опросу ничто не мешает' },
        );
      } catch (err) {
        add({ ok: false, name: 'вебхук', detail: `getWebhookInfo не прошёл: ${api.redact((err as Error).message)}`, todo: 'проверь сеть и повтори' });
      }
    }
  }

  // 6. База: открывается, версия схемы, quick_check.
  const ins = inspectDatabase(paths.db);
  if (!ins.opened) {
    const missing = ins.error?.kind === 'missing';
    add({
      ok: false,
      name: 'база',
      detail: missing ? 'gateway.db ещё нет' : `не открывается: ${ins.error?.message ?? '?'}`,
      todo: missing ? 'запусти шлюз — он создаст базу' : 'останови службу; восстанови из копии: stg restore <файл из backup/>',
    });
    add({ ok: false, name: 'версия схемы', detail: 'база не открылась', todo: 'см. строку «база»' });
    add({ ok: false, name: 'quick_check', detail: 'база не открылась', todo: 'см. строку «база»' });
  } else {
    add({ ok: true, name: 'база', detail: 'gateway.db открывается на чтение' });
    const v = ins.version;
    if (ins.error && (ins.error.kind === 'foreign' || v === null)) {
      add({ ok: false, name: 'версия схемы', detail: ins.error.message, todo: 'это не база шлюза: проверь STG_HOME' });
    } else if (v === SCHEMA_VERSION) {
      add({ ok: true, name: 'версия схемы', detail: `v${v}` });
    } else if (v !== null && v < SCHEMA_VERSION) {
      add({ ok: false, name: 'версия схемы', detail: `v${v}, код знает v${SCHEMA_VERSION}`, todo: 'перезапусти шлюз — он обновит схему' });
    } else {
      add({ ok: false, name: 'версия схемы', detail: `v${v}, код знает только v${SCHEMA_VERSION}`, todo: 'обнови шлюз: код старее базы' });
    }
    const qc = ins.quickCheck ?? [];
    add(
      qc.length === 0
        ? { ok: true, name: 'quick_check', detail: 'ok' }
        : { ok: false, name: 'quick_check', detail: qc[0] ?? 'повреждения', todo: 'останови службу; восстанови из копии: stg restore <файл из backup/>' },
    );
  }

  // 7. Node.
  add(
    nodeVersionOk(process.version)
      ? { ok: true, name: 'Node', detail: `${process.execPath} ${process.version}` }
      : { ok: false, name: 'Node', detail: `${process.execPath} ${process.version}, нужен ≥ 22.19`, todo: 'поставь Node ≥ 22.19 (например, brew install node)' },
  );

  // 8. @modelcontextprotocol/sdk у канала: 1.x, закреплён (5.11).
  const sdk = channelSdkVersion();
  if (!sdk.installed) {
    add({ ok: false, name: 'MCP SDK канала', detail: 'не найден', todo: 'npm ci в репозитории шлюза' });
  } else if (!sdk.installed.startsWith('1.') || (sdk.pinned !== null && sdk.pinned !== sdk.installed)) {
    add({
      ok: false,
      name: 'MCP SDK канала',
      detail: `${sdk.installed}, закреплена ${sdk.pinned ?? '?'}`,
      todo: 'npm ci в репозитории шлюза (нужна закреплённая 1.x)',
    });
  } else {
    add({ ok: true, name: 'MCP SDK канала', detail: `${sdk.installed} (закреплена)` });
  }

  // 9. Служба launchd: плист и launchctl print (только чтение).
  if (config) {
    const label = launchdLabel(config.bot);
    const plist = path.join(launchAgentsDir(env), `${label}.plist`);
    if (!fs.existsSync(plist)) {
      add({ ok: false, name: 'служба', detail: `плиста нет (${plist})`, todo: 'установка — scripts/install-macos.sh, по слову владельца' });
    } else {
      // Плист: Node, флаги памяти (N-2), stg-gateway, KeepAlive, STG_HOME — и версия того Node, что в плисте.
      const pc = checkGatewayPlist(fs.readFileSync(plist, 'utf8'), paths.home);
      add(pc.ok ? { ok: true, name: 'плист службы', detail: pc.detail } : { ok: false, name: 'плист службы', detail: pc.detail, todo: 'переустанови службу: scripts/install-macos.sh (по слову владельца)' });
      if (pc.node) {
        const nv = fs.existsSync(pc.node) ? await run(pc.node, ['--version']) : null;
        const ver = nv?.code === 0 ? nv.stdout.trim() : null;
        add(
          ver && nodeVersionOk(ver)
            ? { ok: true, name: 'Node службы', detail: `${pc.node} ${ver}` }
            : {
                ok: false,
                name: 'Node службы',
                detail: ver ? `${pc.node} ${ver}, нужен ≥ 22.19` : `${pc.node} не запускается`,
                todo: `поставь Node ≥ 22.19 по этому пути или переустанови службу с другим (scripts/install-macos.sh --node <путь>)`,
              },
        );
      }
      const uid = process.getuid?.() ?? 0;
      const r = await run(launchctlPath(env), ['print', `gui/${uid}/${label}`]);
      if (r.code === 0) {
        const state = /state = (\S+)/.exec(r.stdout)?.[1] ?? '?';
        const pid = /\bpid = (\d+)/.exec(r.stdout)?.[1];
        add(
          state === 'running'
            ? { ok: true, name: 'служба', detail: `${label}: state = running${pid ? `, pid ${pid}` : ''}` }
            : { ok: false, name: 'служба', detail: `${label}: state = ${state}`, todo: `смотри ${paths.launchdLog}` },
        );
      } else {
        add({ ok: false, name: 'служба', detail: `плист есть, launchd службу не знает (${label})`, todo: 'загрузить службу — по слову владельца' });
      }
    }
  }

  // 10. Свободное место.
  try {
    const st = fs.statfsSync(paths.home);
    const free = st.bavail * st.bsize;
    add(
      free >= MIN_FREE_BYTES
        ? { ok: true, name: 'свободное место', detail: gb(free) }
        : { ok: false, name: 'свободное место', detail: `${gb(free)} — мало`, todo: 'освободи место: при полном диске приём останавливается' },
    );
  } catch (err) {
    add({ ok: false, name: 'свободное место', detail: `не узнать: ${(err as Error).message}`, todo: 'проверь диск' });
  }

  return { lines, code: lines.every((l) => l.ok) ? 0 : 1, home: paths.home };
}

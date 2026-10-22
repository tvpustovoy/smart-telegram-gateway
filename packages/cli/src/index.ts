#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// stg — CLI шлюза (TECH-SPEC 5). Базу открывает только на чтение (restore — при остановленной службе); в сокет — ping
// и запросы с role cli (где мы, повтор отложенного). Установка: service plist и agent-folder собирают файлы — службу
// ставит scripts/install-macos.sh.
// Модули команд грузятся по требованию: `stg agent-state statusline` Claude Code запускает при каждой перерисовке
// строки агента — она не тянет ни базу, ни весь stg-core (5.14).

import type { CmdResult } from './backup.js';

const USAGE = `stg — CLI шлюза smart-telegram-gateway

  stg doctor [--home <каталог>]           проверки: да / нет / что сделать
  stg status [--home <каталог>]           опрос, события, отправка, отложенное, задержки p50/p90 за сутки
  stg where [--home <каталог>]            где мы: эпизод и тема, что ждёт ответа, на связи ли агент
  stg rules show [--home <каталог>]       правила доступа: рабочая копия, rules.yaml, что ждёт кнопки, изменения
  stg backup [--home <каталог>]           копия базы (VACUUM INTO) и raw/ в backup/
  stg restore <файл> [--home <каталог>]   восстановить из копии — только при остановленной службе
  stg deferred list [--home <каталог>]    отложенные обновления (на них шлюз падал)
  stg deferred retry <update_id>          повторить отложенное (делает шлюз, через его сокет)
  stg log tail [N] [--home <каталог>]     последние строки журнала
  stg service plist [--node <путь>]       плист службы launchd (печатает; ставит scripts/install-macos.sh)
  stg agent-folder <папка> [--node <путь>] [--statusline-then <команда>]
                                          развернуть шаблон папки агента (scripts/agent-folder/)
  stg agent-state statusline [--home <каталог>] [--then <команда>]
                                          строка состояния Claude Code → agent-state.json (всегда код 0)
  stg agent-state hook [--home <каталог>] перехватчики PreCompact, PostCompact, StopFailure → agent-state.json
  stg agent-state settings [--home <каталог>] [--node <путь>] [--statusline-then <команда>]
                           [--agent-dir <папка сессии> [--claude-config <каталог>]]
                                          файл настроек для claude --settings (печатает; какая прежняя
                                          строка состояния в нём — в stderr)

Каталог бота — STG_HOME или единственный каталог в ~/.smart-telegram-gateway/.`;

/** Команды, которые придут на следующих этапах (TECH-SPEC 5). */
const LATER: Record<string, string> = {};

function takeHome(args: string[]): { home: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let home: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--home') home = args[++i];
    else rest.push(args[i]!);
  }
  return { home, rest };
}

function print(r: CmdResult): number {
  for (const l of r.out) process.stdout.write(l + '\n');
  for (const l of r.err ?? []) process.stderr.write(l + '\n');
  return r.code;
}

export async function cli(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [cmd, ...rest] = argv;
  // Строка состояния и перехватчики агента — первыми и без прочих модулей; код выхода всегда 0.
  if (cmd === 'agent-state' && (rest[0] === 'statusline' || rest[0] === 'hook')) {
    try {
      const m = await import('./agent-state.js');
      return rest[0] === 'statusline' ? await m.runAgentStateStatusline(rest.slice(1), env) : await m.runAgentStateHook(rest.slice(1), env);
    } catch (err) {
      process.stderr.write(`stg agent-state: ${(err as Error).message}\n`);
      return 0;
    }
  }
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(USAGE + '\n');
    return cmd ? 0 : 2;
  }
  if (cmd === 'doctor') {
    const { formatLine, runDoctor } = await import('./doctor.js');
    let home: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--home') home = rest[++i];
      else {
        process.stderr.write(`stg doctor: не знаю аргумент «${rest[i]}»\n`);
        return 2;
      }
    }
    const { lines, code, home: resolved } = await runDoctor(home ? { env, home } : { env });
    process.stdout.write(`stg doctor · ${resolved ?? 'каталог не найден'}\n`);
    for (const l of lines) process.stdout.write(formatLine(l) + '\n');
    const bad = lines.filter((l) => !l.ok).length;
    process.stdout.write(bad ? `итого: «нет» — ${bad} из ${lines.length}\n` : `итого: всё «да» (${lines.length})\n`);
    return code;
  }
  const { home, rest: args } = takeHome(rest);
  try {
    if (cmd === 'status' && !args.length) return print(await (await import('./status.js')).runStatus(env, home));
    if (cmd === 'where' && !args.length) return print(await (await import('./where.js')).runWhere(env, home));
    if (cmd === 'rules' && args[0] === 'show' && args.length === 1) return print(await (await import('./rules.js')).runRulesShow(env, home));
    if (cmd === 'backup' && !args.length) return print(await (await import('./backup.js')).runBackup(env, home));
    if (cmd === 'restore' && args.length === 1) return print(await (await import('./backup.js')).runRestore(env, args[0]!, home));
    if (cmd === 'deferred' && args[0] === 'list' && args.length === 1) return print(await (await import('./status.js')).runDeferredList(env, home));
    if (cmd === 'deferred' && args[0] === 'retry' && args.length === 2) return print(await (await import('./status.js')).runDeferredRetry(env, args[1]!, home));
    if (cmd === 'service' && args[0] === 'plist') return print(await (await import('./install.js')).runServicePlist(env, args.slice(1), home));
    if (cmd === 'agent-folder' && args.length >= 1) return print(await (await import('./install.js')).runAgentFolder(env, args, home));
    if (cmd === 'agent-state' && args[0] === 'settings') return print(await (await import('./install.js')).runAgentStateSettings(env, args.slice(1), home));
    if (cmd === 'log' && args[0] === 'tail' && args.length <= 2) return print((await import('./status.js')).runLogTail(env, Number(args[1] ?? '40') || 40, home));
  } catch (err) {
    process.stderr.write(`stg ${cmd}: ${(err as Error).message}\n`);
    return 1;
  }
  if (['status', 'where', 'rules', 'backup', 'restore', 'deferred', 'log', 'service', 'agent-folder', 'agent-state'].includes(cmd)) {
    process.stderr.write(`stg ${cmd}: не понял аргументы\n${USAGE}\n`);
    return 2;
  }
  const stage = LATER[cmd];
  process.stderr.write(stage ? `stg ${cmd}: команда появится на этапе ${stage}\n` : `stg: не знаю команду «${cmd}»\n${USAGE}\n`);
  return 2;
}

cli(process.argv.slice(2), process.env).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`stg: ${(err as Error).message}\n`);
    process.exit(1);
  },
);

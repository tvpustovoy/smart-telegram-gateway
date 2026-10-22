#!/bin/sh
# Сессия агента «личный ассистент» с каналом smart-telegram-gateway (TECH-SPEC 5.11, 5.12).
# Запуск только интерактивный: при каждом старте Claude Code предупреждает о канале разработчика — человек у
# терминала подтверждает. Сессия живёт в отдельном окне Terminal или в tmux; после перезагрузки её поднимает человек.
# Возобновить разговор — только этим же скриптом: ./start.sh --continue (если канал при возобновлении не
# регистрируется — новый разговор: контекст есть в notes/ и итогах эпизодов).
# Свой каталог настроек Claude Code (CLAUDE_CONFIG_DIR): в сессии только роль — без плагинов,
# хуков и глобального CLAUDE.md владельца. При первом запуске — войти в подписку командой /login.
# Строка состояния и перехватчики сжатия и отказа модели (TECH-SPEC 5.14) — файл .claude/agent-state.settings.json,
# флагом --settings: из них шлюз знает контекст, сжатие и лимиты агента (значки 🧠 🕐 в закреплённой строке).
set -eu
cd "$(dirname "$0")"
CLAUDE_CONFIG_DIR="$PWD/.claude-config"
export CLAUDE_CONFIG_DIR
mkdir -p "$CLAUDE_CONFIG_DIR" notes parcels
if [ -f "$PWD/.claude/agent-state.settings.json" ]; then
  set -- --settings "$PWD/.claude/agent-state.settings.json" "$@"
fi
exec claude --dangerously-load-development-channels server:smart-telegram-gateway "$@"

#!/bin/bash
# smart-telegram-gateway — удаление службы на macOS (ACCEPTANCE N-4: не остаётся ничего, кроме каталога состояния).
# Запускает владелец сам.
#
#   scripts/uninstall-macos.sh <бот> [--agent-dir <папка>] [--remove-agent-folder]
#
# Снимает службу (launchctl bootout) и удаляет её плист. Каталог состояния ~/.smart-telegram-gateway/<бот>/ (база,
# журнал, звук, настройки) остаётся — там принятые сообщения; токен в связке ключей остаётся. Папка агента (заметки)
# остаётся, если не сказано --remove-agent-folder.
set -euo pipefail

die() {
  echo "uninstall-macos.sh: $*" >&2
  exit 1
}

BOT=""
AGENT_DIR="$HOME/Agents/assistant"
REMOVE_AGENT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) AGENT_DIR="${2:?нужна папка}"; shift 2 ;;
    --remove-agent-folder) REMOVE_AGENT=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    -*) die "не знаю ключ $1" ;;
    *) [ -z "$BOT" ] || die "бот уже задан: $BOT"; BOT="$1"; shift ;;
  esac
done
[ -n "$BOT" ] || die "нужно имя бота: scripts/uninstall-macos.sh <бот>"
printf '%s' "$BOT" | grep -Eq '^[A-Za-z0-9_]{1,64}$' || die "имя бота — латиница, цифры и «_»: $BOT"
[ "$(uname -s)" = "Darwin" ] || die "только macOS"

LABEL="local.smart-telegram-gateway.$BOT"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

echo "служба: launchctl bootout gui/$UID_NUM/$LABEL"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || echo "   службы в launchd нет"
rm -f "$PLIST"
echo "плист удалён: $PLIST"

if [ "$REMOVE_AGENT" -eq 1 ]; then
  # Удаляется только папка, развёрнутая из шаблона: start.sh с каналом шлюза и .mcp.json с ключом сервера; не $HOME, не
  # корень и не путь короче двух уровней (ошибка в --agent-dir не снесёт домашнюю папку и вход Claude Code).
  [ -d "$AGENT_DIR" ] || die "$AGENT_DIR — нет такой папки"
  AGENT_REAL="$(cd "$AGENT_DIR" && pwd -P)"
  HOME_REAL="$(cd "$HOME" && pwd -P)"
  DEPTH="$(printf '%s' "$AGENT_REAL" | tr -cd '/' | wc -c | tr -d ' ')"
  [ "$AGENT_REAL" != "/" ] && [ "$AGENT_REAL" != "$HOME_REAL" ] && [ "$DEPTH" -ge 2 ] || die "$AGENT_REAL — не папка агента (корень, домашняя папка или слишком короткий путь) — не удаляю"
  [ -f "$AGENT_REAL/start.sh" ] && grep -q 'server:smart-telegram-gateway' "$AGENT_REAL/start.sh" || die "$AGENT_REAL/start.sh — не из шаблона папки агента — не удаляю"
  [ -f "$AGENT_REAL/.mcp.json" ] && grep -q '"smart-telegram-gateway"' "$AGENT_REAL/.mcp.json" || die "$AGENT_REAL/.mcp.json — без сервера smart-telegram-gateway — не удаляю"
  echo "удаляю папку агента целиком (заметки notes/, вход Claude Code .claude-config/): $AGENT_REAL"
  rm -rf "$AGENT_REAL"
  echo "папка агента удалена: $AGENT_REAL"
else
  echo "папка агента оставлена: $AGENT_DIR (заметки; удалить — --remove-agent-folder)"
fi
echo "каталог состояния оставлен: $HOME/.smart-telegram-gateway/$BOT (база, журнал, звук, настройки)"
echo "токен в связке ключей оставлен: security delete-generic-password -s smart-telegram-gateway -a $BOT/telegram"

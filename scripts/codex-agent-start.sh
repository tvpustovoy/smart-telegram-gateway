#!/bin/bash
# Подключить к шлюзу существующего агента Codex (#55): адаптер stg-codex в видимом окне терминала — живая лента
# разговора: что пришло из Telegram, что агент делает (команды, вызовы инструментов шлюза), что ушло владельцу.
#
#   scripts/codex-agent-start.sh --agent-dir <папка агента> [--stg-home <каталог бота>] [--codex <путь>] [--node <путь>]
#                                [--window | --here | --tmux | --print]
#
#   --agent-dir   папка агента Codex: его AGENTS.md, рабочий каталог команд. Адаптер в неё не пишет
#   --stg-home    каталог бота; по умолчанию STG_HOME, иначе единственный каталог в ~/.smart-telegram-gateway/
#   --codex       codex (или его codex.js); по умолчанию — codex из PATH
#   --node        Node ≥ 22.13; по умолчанию — node из PATH
#   --window      (по умолчанию) новое окно iTerm, если он есть, иначе Terminal
#   --here        в этом окне
#   --tmux        в сессии tmux stg-codex-<бот> (подключиться: tmux attach -t stg-codex-<бот>)
#   --print       только напечатать команду, ничего не запускать
#
# Codex — с настройками и входом пользователя как есть (CODEX_HOME не задаётся): модель и прочее — из ~/.codex. Права —
# базовые: песочница workspace-write в папке агента и в папке посылок шлюза (вне папки агента), сеть у команд закрыта,
# запросов разрешения нет. Технический журнал адаптера — <каталог бота>/codex/adapter.log; состояние (id треда) —
# <каталог бота>/codex/state.json. Остановить — Ctrl-C в окне: аренда снимается, Codex закрывается.
set -euo pipefail

die() {
  echo "codex-agent-start.sh: $*" >&2
  exit 1
}

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SELF="$REPO/scripts/codex-agent-start.sh"
ENTRY="$REPO/packages/codex/dist/index.js"
AGENT_DIR=""
HOME_DIR="${STG_HOME:-}"
CODEX=""
NODE=""
HOW="window"

while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) AGENT_DIR="${2:?нужна папка агента}"; shift 2 ;;
    --stg-home) HOME_DIR="${2:?нужен каталог бота}"; shift 2 ;;
    --codex) CODEX="${2:?нужен путь к codex}"; shift 2 ;;
    --node) NODE="${2:?нужен путь к node}"; shift 2 ;;
    --window) HOW="window"; shift ;;
    --here) HOW="here"; shift ;;
    --tmux) HOW="tmux"; shift ;;
    --print) HOW="print"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "не знаю ключ $1 (--help — справка)" ;;
  esac
done

[ -n "$AGENT_DIR" ] || die "нужна --agent-dir <папка агента>"
[ -d "$AGENT_DIR" ] || die "нет папки агента: $AGENT_DIR"
AGENT_DIR="$(cd "$AGENT_DIR" && pwd -P)"

if [ -z "$HOME_DIR" ]; then
  ROOT="$HOME/.smart-telegram-gateway"
  [ -d "$ROOT" ] || die "нет $ROOT — задай --stg-home или поставь шлюз"
  set +o pipefail
  COUNT="$(find "$ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  set -o pipefail
  [ "$COUNT" = "1" ] || die "в $ROOT каталогов ботов: $COUNT — задай --stg-home"
  HOME_DIR="$(find "$ROOT" -mindepth 1 -maxdepth 1 -type d)"
fi
[ -d "$HOME_DIR" ] || die "нет каталога бота: $HOME_DIR"
HOME_DIR="$(cd "$HOME_DIR" && pwd -P)"
BOT="$(basename "$HOME_DIR")"

[ -n "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] && [ -x "$NODE" ] || die "нет Node (поставь Node ≥ 22.13 или укажи --node)"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "нужен Node ≥ 22.13, а $NODE — $("$NODE" --version)"
[ -n "$CODEX" ] || CODEX="$(command -v codex || true)"
[ -n "$CODEX" ] && [ -e "$CODEX" ] || die "нет codex в PATH (npm install -g @openai/codex) — или укажи --codex <путь>"
[ -f "$ENTRY" ] || die "адаптер не собран: cd $REPO && npm ci && npm run build"

LOG_DIR="$HOME_DIR/codex"

# Команда в кавычках для оболочки: 'a'\''b'.
q() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

INNER="$(q "$SELF") --here --agent-dir $(q "$AGENT_DIR") --stg-home $(q "$HOME_DIR") --codex $(q "$CODEX") --node $(q "$NODE")"

case "$HOW" in
  print)
    echo "$INNER"
    ;;
  here)
    mkdir -p "$LOG_DIR"
    chmod 700 "$LOG_DIR"
    printf '\033]0;stg-codex · %s\007' "$BOT"
    echo "stg-codex · бот $BOT · агент $AGENT_DIR"
    echo "журнал: $LOG_DIR/adapter.log · остановить: Ctrl-C"
    echo
    set +e
    STG_HOME="$HOME_DIR" "$NODE" --disable-warning=ExperimentalWarning "$ENTRY" --agent-dir "$AGENT_DIR" --codex "$CODEX" 2>>"$LOG_DIR/adapter.log"
    CODE=$?
    set -e
    echo
    echo "stg-codex завершился (код $CODE). Журнал: $LOG_DIR/adapter.log"
    exit "$CODE"
    ;;
  tmux)
    command -v tmux >/dev/null || die "нет tmux"
    SESSION="stg-codex-$BOT"
    tmux has-session -t "$SESSION" 2>/dev/null && die "сессия tmux $SESSION уже есть: tmux attach -t $SESSION"
    tmux new-session -d -s "$SESSION" "$INNER; exec \$SHELL"
    echo "запущено в tmux: tmux attach -t $SESSION"
    ;;
  window)
    [ "$(uname -s)" = "Darwin" ] || die "окно — только на macOS; запусти с --here или --tmux"
    # Строка AppleScript: \ и " — с обратной косой.
    AS_CMD="$(printf '%s' "$INNER" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    if [ -d "/Applications/iTerm.app" ]; then
      osascript >/dev/null <<EOF
tell application "iTerm"
  activate
  set w to (create window with default profile)
  tell current session of w to write text "$AS_CMD"
end tell
EOF
    else
      osascript >/dev/null <<EOF
tell application "Terminal"
  activate
  do script "$AS_CMD"
end tell
EOF
    fi
    echo "stg-codex запущен в новом окне (бот $BOT, агент $AGENT_DIR)"
    ;;
esac

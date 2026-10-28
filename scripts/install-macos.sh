#!/bin/bash
# smart-telegram-gateway — установка на macOS (TECH-SPEC 5.1, 5.3, 5.12; ACCEPTANCE N-4).
# Ставит службу пользователя (LaunchAgent, без прав администратора) и разворачивает папку агента. Запускает владелец
# сам (TECH-SPEC §9) или агент по его просьбе (INSTALL.md): скрипт загружает службу в launchd.
#
#   scripts/install-macos.sh <бот> [--harness claude|codex] [--node <путь>] [--agent-dir <папка>] [--codex <путь>]
#                            [--timezone <пояс>]
#
#   <бот>         имя бота у BotFather (латиница, цифры, «_») — каталог ~/.smart-telegram-gateway/<бот>/
#   --node        Node ≥ 22.19 для службы и канала; по умолчанию /opt/homebrew/bin/node (Node из Homebrew)
#   --harness     claude (по умолчанию) — сессия Claude Code с каналом; codex — существующий агент Codex через
#                 адаптер stg-codex (#55): папку агента скрипт не трогает
#   --agent-dir   папка агента; claude — по умолчанию ~/Agents/assistant; codex — обязательна (рабочая папка агента)
#   --codex       codex для --harness codex; по умолчанию — codex из PATH
#   --timezone    пояс владельца для config.yaml; по умолчанию — пояс системы
#
# Что делает: проверяет macOS и Node → собирает репозиторий (npm ci, если нет node_modules; npm run build) → каталог
# бота 0700 и config.yaml (если его нет; owner_id пустой — первая настройка) → плист службы из шаблона
# (stg service plist: Node, флаги памяти GATEWAY_NODE_FLAGS, KeepAlive, ThrottleInterval 10, ProcessType Interactive,
# журнал logs/launchd.log) → launchctl bootout (прежняя) и bootstrap (новая) → папка агента (stg agent-folder) →
# что делать дальше. Токен бота в связку ключей кладёт владелец сам: скрипт его не видит.
# Повторный запуск — переустановка: config.yaml, rules.yaml, база и заметки агента не трогаются.
set -euo pipefail

die() {
  echo "install-macos.sh: $*" >&2
  exit 1
}

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BOT=""
NODE="/opt/homebrew/bin/node"
AGENT_DIR=""
HARNESS="claude"
CODEX=""
TZ_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE="${2:?нужен путь к node}"; shift 2 ;;
    --agent-dir) AGENT_DIR="${2:?нужна папка}"; shift 2 ;;
    --harness) HARNESS="${2:?нужно claude или codex}"; shift 2 ;;
    --codex) CODEX="${2:?нужен путь к codex}"; shift 2 ;;
    --timezone) TZ_NAME="${2:?нужен пояс}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    -*) die "не знаю ключ $1" ;;
    *) [ -z "$BOT" ] || die "бот уже задан: $BOT"; BOT="$1"; shift ;;
  esac
done

[ -n "$BOT" ] || die "нужно имя бота: scripts/install-macos.sh <бот>"
case "$HARNESS" in
  claude) [ -n "$AGENT_DIR" ] || AGENT_DIR="$HOME/Agents/assistant" ;;
  codex)
    [ -n "$AGENT_DIR" ] || die "для --harness codex нужна --agent-dir: рабочая папка агента Codex"
    [ -d "$AGENT_DIR" ] || die "нет папки агента: $AGENT_DIR"
    AGENT_DIR="$(cd "$AGENT_DIR" && pwd)"
    [ -n "$CODEX" ] || CODEX="$(command -v codex || true)"
    [ -n "$CODEX" ] && [ -x "$CODEX" ] || die "нет codex: поставь Codex CLI (npm i -g @openai/codex) или укажи --codex"
    ;;
  *) die "--harness: claude или codex, а не $HARNESS" ;;
esac
printf '%s' "$BOT" | grep -Eq '^[A-Za-z0-9_]{1,64}$' || die "имя бота — латиница, цифры и «_»: $BOT"
[ "$(uname -s)" = "Darwin" ] || die "только macOS"
[ "$(id -u)" -ne 0 ] || die "не от root: служба — пользовательская"
[ -x "$NODE" ] || die "нет Node: $NODE (поставь Node ≥ 22.19 или укажи --node)"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || die "нужен Node ≥ 22.19, а $NODE — $("$NODE" --version)"

STG_HOME="$HOME/.smart-telegram-gateway/$BOT"
LABEL="local.smart-telegram-gateway.$BOT"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
UID_NUM="$(id -u)"
STG=("$NODE" --disable-warning=ExperimentalWarning "$REPO/packages/cli/dist/index.js")

echo "1/6 сборка: $REPO"
cd "$REPO"
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="npm"
[ -d node_modules ] || PATH="$(dirname "$NODE"):$PATH" "$NPM" ci
PATH="$(dirname "$NODE"):$PATH" "$NPM" run build

echo "2/6 каталог бота: $STG_HOME"
mkdir -p "$STG_HOME/logs"
chmod 700 "$HOME/.smart-telegram-gateway" "$STG_HOME"
if [ ! -f "$STG_HOME/config.yaml" ]; then
  if [ -z "$TZ_NAME" ]; then
    TZ_NAME="$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"
  fi
  [ -n "$TZ_NAME" ] || TZ_NAME="UTC"
  # umask — только для config.yaml (в подоболочке): права остальных файлов не зависят от того, первая ли это установка.
  (
    umask 077
    cat > "$STG_HOME/config.yaml" <<YAML
bot: $BOT
owner_id:                      # первая настройка: напиши боту /start, stg doctor покажет номер — впиши его сюда
timezone: $TZ_NAME
YAML
  )
  echo "   config.yaml создан (owner_id пуст — первая настройка)"
else
  echo "   config.yaml уже есть — не трогаю"
fi

echo "3/6 плист службы: $PLIST"
mkdir -p "$PLIST_DIR"
TMP_PLIST="$(mktemp "$PLIST_DIR/.$LABEL.XXXXXX")"
# Временный файл не остаётся в LaunchAgents ни при какой ошибке (испорченный config.yaml, plutil).
trap 'rm -f "$TMP_PLIST"' EXIT
STG_HOME="$STG_HOME" "${STG[@]}" service plist --node "$NODE" > "$TMP_PLIST"
plutil -lint "$TMP_PLIST" >/dev/null || die "плист не прошёл plutil -lint"
mv "$TMP_PLIST" "$PLIST"

echo "4/6 служба: launchctl bootstrap gui/$UID_NUM $LABEL"
if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  # Прежний шлюз останавливается до 10 с: bootstrap раньше времени — «Bootstrap failed: 5: Input/output error».
  for _ in $(seq 1 15); do
    launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || break
    sleep 1
  done
fi
BOOTSTRAPPED=0
for try in 1 2 3; do
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST"; then
    BOOTSTRAPPED=1
    break
  fi
  echo "   bootstrap не прошёл (попытка $try из 3) — жду и пробую снова"
  sleep 3
done
[ "$BOOTSTRAPPED" -eq 1 ] || die "launchctl bootstrap не прошёл трижды: смотри launchctl print gui/$UID_NUM/$LABEL и $STG_HOME/logs/launchd.log"
launchctl print "gui/$UID_NUM/$LABEL" | grep -E '^\s*(state|pid) =' || true

if [ "$HARNESS" = "codex" ]; then
  echo "5/6 агент Codex: $AGENT_DIR — папку не трогаю (роль — его AGENTS.md; правила канала адаптер передаёт сам)"
  mkdir -p "$STG_HOME/parcels"
  echo "6/6 готово. Дальше:"
  cat <<NEXT
  - токен бота — в связку ключей (ввод без эха; вводит владелец):
      security add-generic-password -s smart-telegram-gateway -a $BOT/telegram -w
  - голосовые (необязательно) — ключ OpenAI, ввод без эха:
      security add-generic-password -s smart-telegram-gateway -a openai -w
  - владелец пишет боту /start с телефона, затем:
      STG_HOME="$STG_HOME" ${STG[*]} doctor
    показанный номер — в $STG_HOME/config.yaml (owner_id), перезапустить службу:
      launchctl kickstart -k gui/$UID_NUM/$LABEL
  - агент Codex — в видимом окне Terminal/iTerm (живая лента разговора; Ctrl-C — остановить):
      $REPO/scripts/codex-agent-start.sh --agent-dir "$AGENT_DIR" --stg-home "$STG_HOME" --node "$NODE" --codex "$CODEX"
  - удалить службу: scripts/uninstall-macos.sh $BOT
NEXT
  exit 0
fi

echo "5/6 папка агента: $AGENT_DIR"
STG_HOME="$STG_HOME" "${STG[@]}" agent-folder "$AGENT_DIR" --node "$NODE"

echo "6/6 готово. Дальше:"
cat <<NEXT
  - токен бота — в связку ключей (ввод без эха):
      security add-generic-password -s smart-telegram-gateway -a $BOT/telegram -w
  - ключ голоса (по умолчанию — OpenAI; ElevenLabs и непроверенный OpenRouter — docs/TECH-SPEC.md, 5.1 и 5.8), ввод без эха:
      security add-generic-password -s smart-telegram-gateway -a openai -w
  - написать боту /start с телефона, затем:
      STG_HOME="$STG_HOME" ${STG[*]} doctor
    и вписать показанный номер в $STG_HOME/config.yaml (owner_id), перезапустить службу:
      launchctl kickstart -k gui/$UID_NUM/$LABEL
  - сессия агента — в отдельном окне Terminal или в tmux:
      $AGENT_DIR/start.sh
    (первый раз — /login; Claude Code спросит про канал разработчика — подтвердить)
  - удалить службу: scripts/uninstall-macos.sh $BOT
NEXT

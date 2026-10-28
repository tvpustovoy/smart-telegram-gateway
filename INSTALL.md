# Install smart-telegram-gateway with your agent

This page is written for an AI coding agent: Codex (or Claude Code) running on the owner's Mac. The owner gives you the
link to this repository and asks you to install it **for yourself**: so that they can talk to you from Telegram.

Work step by step. Ask the owner only for what only they can do, marked **Owner**. Never ask the owner to paste a token
or a key into the chat: they type it into the Keychain themselves, and you never see it.

## 0. Check the machine

- macOS (the gateway runs as a user LaunchAgent; Linux and Windows are not supported yet).
- Node.js ≥ 22.19: `node --version`. If it is missing or older, ask the owner to install it (`brew install node`).
- Codex CLI: `codex --version` (checked with 0.163). Claude Code instead: `claude --version`.
- Your own working folder — the folder you were started in (`pwd`). This is the **agent folder**: the gateway connects
  Telegram to the agent that runs here.

## 1. Get the code

```bash
git clone https://github.com/tvpustovoy/smart-telegram-gateway ~/smart-telegram-gateway
cd ~/smart-telegram-gateway
```

## 2. Owner: create the bot

**Owner:** in Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, choose a name and a username ending
in `bot`. Tell the agent the username (without `@`), e.g. `my_helper_bot`. Keep the token for step 4.

## 3. Install the gateway service

Codex agent (your folder is the agent folder; the installer does not write into it):

```bash
scripts/install-macos.sh <bot_username> --harness codex --agent-dir "<your working folder>"
```

Claude Code agent (the installer sets up a fresh agent folder, `~/Agents/assistant` by default):

```bash
scripts/install-macos.sh <bot_username>
```

The installer builds the code, creates `~/.smart-telegram-gateway/<bot_username>/` with `config.yaml`, and starts the
gateway as a LaunchAgent. It prints the next steps; they are the same as below.

## 4. Owner: put the token into the Keychain

**Owner**, in their own Terminal window (the input is hidden; macOS asks for it twice):

```bash
security add-generic-password -s smart-telegram-gateway -a <bot_username>/telegram -w
```

Voice messages (optional): an OpenAI API key, the same way, account `openai`:

```bash
security add-generic-password -s smart-telegram-gateway -a openai -w
```

## 5. Owner: say hello to the bot, then set the owner

**Owner:** open the bot in Telegram and send `/start`.

Then you:

```bash
STG_HOME=~/.smart-telegram-gateway/<bot_username> node --disable-warning=ExperimentalWarning packages/cli/dist/index.js doctor
```

`doctor` shows the Telegram user id of whoever wrote to the bot. Confirm with the owner that it is them, write it into
`~/.smart-telegram-gateway/<bot_username>/config.yaml` as `owner_id: <number>`, and restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/local.smart-telegram-gateway.<bot_username>
```

Run `doctor` again: everything should be OK.

## 6. Start the agent in a visible window

Codex:

```bash
scripts/codex-agent-start.sh --agent-dir "<your working folder>" --stg-home ~/.smart-telegram-gateway/<bot_username>
```

A new iTerm or Terminal window opens with the live feed: what came from Telegram, what the agent does, what went to
the owner. Ctrl-C in that window stops the agent; the gateway keeps accepting messages and delivers them when the agent
is back. Claude Code: run `~/Agents/assistant/start.sh` in a Terminal window (first time: `/login`, then confirm the
development channel).

## 7. Check

**Owner:** write to the bot. The message gets 👀, the chat shows "typing…", and the answer comes from the agent.

## Remove

```bash
scripts/uninstall-macos.sh <bot_username>
```

The service goes away; the message history in `~/.smart-telegram-gateway/<bot_username>/` and the Keychain entries stay.

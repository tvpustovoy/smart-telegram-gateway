# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, any minor or patch release may change behavior,
the chat interface and the database schema. Schema migrations run automatically when the gateway starts; going back to
an older version after a migration is only possible from a database backup taken before the upgrade (`stg backup`).

The chat interface and the design documents are in Russian; the entries below describe behavior in English.

## 0.3.5 - 2026-10-22

### Added

- Current channel rules reach a resumed conversation (#47). Claude Code passes an MCP server's instructions to a
  conversation only when the channel first connects to it: a conversation continued with `--resume` keeps the
  instructions it got back then (tool descriptions do update), and a conversation started without the channel never
  gets them. The channel now names the version of its instructions in `hello` (`instructions_version`, the start of a
  SHA-256 of the text). The gateway remembers which version each agent conversation has confirmed (keyed by the Claude
  Code session from the status line, or by the channel process while the session is unknown) and gives a conversation
  with an old or unknown version one gateway event "channel rules" — `[№ N · правила канала, версия …]` followed by the
  full current instructions. The agent marks it `done`, and the version is recorded for that conversation.
- The rules event is a service event, like the channel check: it goes ahead of the waiting messages, also during stop
  and pause, is redelivered by the usual timer, stays with the same conversation across a dropped connection or a
  gateway restart, and is closed when another conversation's channel takes the queue. Within one channel connection a
  conversation gets at most one rules event, even when the status lines of two sessions in the same folder alternate;
  `done` on an event the connection sent earlier still counts. A brand-new conversation, which already has the
  instructions from Claude Code, gets the event once as well: the gateway cannot tell it from a resumed one.
- `where()` called by the agent ends with a line about the channel rules: received by this conversation, waiting for
  `done`, or not received — then the event is sent. The descriptions of `reply`, `done` and `where` point to the event
  and to `where()`; `reply` and `send_file` on the rules event are refused.
- Channel instructions and the agent folder template: the owner is in Telegram, not at the terminal — ask through
  `reply`; on-screen choice prompts, plan mode and permission prompts never reach the owner. Before an action that may
  ask for permission at the terminal, say so in `reply`. A reaction to an "X or Y?" reply chooses nothing: do the light,
  reversible option and say in one `reply` line which one; ask again only when the branches are irreversible.
- `ui.delete_confirmed_topic` in `config.yaml` (default `true`, #48): [верно] under the topic line `⚙ ↪ #N · topic`
  deletes the line — the topic stays visible in the pinned status line. `false` keeps the previous behaviour: the line
  is edited to "… — верно" without buttons. The deletion goes through the sender's queue with retries and survives a
  restart; if Telegram refuses it (the message is older than 48 hours, …) or every attempt fails, the line is edited to
  "… — верно" without buttons and the reason is logged. A line that is already gone (the owner deleted it) counts as
  deleted and is not edited. A second press while the deletion is pending does not edit the line. [не то] is
  unchanged.
- `npm run release-check` (`scripts/release-check.mjs`, no dependencies): scans the files git would commit, and with
  `--history` every object and commit message, against a private denylist named by `STG_DENYLIST` plus built-in checks
  for home-directory paths, e-mail addresses, phone numbers, bot tokens and API keys. Exit code 1 on findings.

### Changed

- Agent folder template: notes are written as blocks — a `---` line and a `## № N · DD.MM HH:MM · <label> · kind: <kind>`
  heading — so that a `№ 7` inside a note is not taken for a note boundary.
- Database schema v12: the `events` table is rebuilt for the new event kind `instructions` (column
  `instructions_json`), the `deletions` table is rebuilt for the new reason `topic` (column `fallback_text`), and a new
  table `conversations` holds the confirmed rules version per agent conversation. Going back to 0.3.4 is possible only
  from a backup taken before the upgrade.
- Protocol: `hello` takes the optional `instructions_version`; events of kind `instructions` carry `instructions
  {version}` and go only to a channel that named a version. A 0.3.5 channel connected to an older gateway repeats
  `hello` without the field (no rules events, as before).
- README and CHANGELOG in English (Russian README: `README.ru.md`).
- `stg doctor`: the Node hint suggests `brew install node`; the OpenRouter transcription note says the Ogg voice path
  and the model name are not verified on a real key.

## 0.3.4 - 2026-10-22

### Added

- Owner reactions reach the agent. A reaction (👍, ❤, any emoji) on an agent reply becomes an event for the agent with
  the reply number and the beginning of the reply; changing a reaction sends a new event, removing it sends a "removed"
  event. A reaction on a document the agent sent with `send_file` counts as a reaction on a reply. Reactions on gateway
  lines, on transcripts, on the owner's own or other people's messages are only logged. The gateway now requests
  `message_reaction` updates from Telegram; a reaction inside a forum topic is answered in that topic; a crash while
  handling a reaction is counted and deferred like any other update. (#34)
- Reaction undo window, `reactions.hold_seconds` in `config.yaml` (default 3, `0` disables, at most 3): a reaction is
  stored at once but handed to the agent only when the window since its last change has passed. Set and removed within
  the window — the agent gets nothing; changed several times — the agent gets one final reaction. Reaction sets are
  compared regardless of order (Premium users can set several). The window survives a gateway restart and never delays
  messages, commands or transcripts. (#46)
- Agent folder template: role rules for reactions (read them by meaning, usually just mark `done`; ask in words before
  doing anything irreversible — sending on the owner's behalf, paying, deleting) and for file requests (`send_file` with
  a caption is the reply).

### Changed

- Transcripts of voice messages, video notes, audio files and videos are sent as a quote (`<blockquote>`, collapsed
  when longer than four lines) in reply to the original message, so they cannot be mistaken for the agent's words.
  "Could not transcribe" notices stay plain text. (#44)
- An agent reply that consists entirely of a quote is marked with `💬` (invisible characters around the quote do not
  change that), so it cannot pass for a transcript.
- Database schema v11: the `events` table is rebuilt to hold reactions.

## 0.3.3 - 2026-10-21

### Added

- Parcels: the agent can reply with files. It puts files into the parcels folder (`parcels/<parcel>/<file>`) and calls
  the new MCP tool `send_file(path, seq?, caption?, from?)`; the file arrives as a document, in reply to the request,
  with the agent's caption. A new version of a file sent before is marked as updated; a relayed file (`from`) is
  labelled with the sender's name. (#29)
- Only regular files inside the parcels folder can be sent. Paths outside it, symlinks or hard links leading outside,
  hidden files, directories, empty files and files over 50 MB are refused with an explanation for the agent. The file
  is opened once and checked by descriptor, so it cannot be swapped between the check and the read.
- By default files go only to the owner's private chat; any other chat needs `parcels: true` on its rule in
  `rules.yaml`.
- Reliable delivery: the gateway keeps its own copy of every accepted file and records each delivery in the database
  (schema v10). A delivery interrupted by a Telegram error or a restart is retried from that copy, even if the source
  file has changed. Stop cancels pending files and aborts an upload in progress. Uploads have a size-based timeout and
  give up after three timeouts; a file that could not be delivered is reported to the owner.
- `parcels.dir` in `config.yaml` (default: `parcels/` in the agent session's working directory) and `parcels.targets`
  (default `[telegram]`). Delivery targets are an extension point reserved for web publishing of parcels.
- Agent folder template: `Edit(./parcels/**)` permission and a section on sending files.

## 0.3.2 - 2026-10-21

### Added

- `reply(from)`: the agent can pass on someone else's words as `↪ Name: …`. The gateway refuses names that imitate the
  gateway or contain line breaks or invisible formatting. Database schema v9.

### Changed

- The ✍ "recorded" reaction is gone. A message shows 👀 when the agent has seen it and 👌 when the agent replied; nothing
  while the agent is offline (the pinned line shows ⚪ and the number of waiting messages). Editing a message removes
  the reaction from the old text.
- Agent replies are plain text. `💬` is added only to a reply that itself starts with a gateway mark (`⚙ 📍 № ↪ 💬`),
  so it cannot pose as a gateway line. Invisible characters before the mark (Unicode classes Z, Cc, Cf, Cn, Co, Cs, M
  and blank-looking letters) are skipped by this check; a long reply gets the mark on its first part.
- The channel check (a model turn) runs only for a new session. The channel identifies its process, so the same Claude
  Code session reconnecting after a dropped socket, sleep or a gateway restart is accepted without a check and without
  redelivery. `/clear` in a running session triggers redelivery without a check; `/resume` to an earlier conversation
  re-sends what that conversation has not seen; the session is recognised after the agent changes into a subfolder.
  `/status` counts the checks saved.
- Agent folder template: always `reply` to the owner's own words (a transcript and 👌 are not a reply); call `where()`
  first when a message refers to something the event does not contain; a short "yes / no / ok" refers to the agent's
  last message.

## 0.3.1 - 2026-10-21

Released together with 0.3.0.

### Changed

- Quiet chat: the owner's message gets reactions — ✍ recorded → 👀 seen by the agent → 👌 answered — instead of service
  lines. A late reaction never replaces a later one. On first start, messages recorded by the previous version and not
  yet delivered get ✍.
- The bottom keyboard is removed: commands live in the ☰ menu and can also be typed as words. On first start the old
  keyboard is removed with a single line.
- Transcripts arrive as a reply to the voice message, video note, audio file or video, text only; long ones in several
  parts, all as replies. A failure is a short line. Transcript receipts are no longer edited, and the transcript button
  is gone.
- Video notes, mp4 videos and the owner's own audio files follow the same flow. A video that is not mp4 gets a short
  "cannot transcribe" reply; a video sent as a file stays an ordinary file.
- The default speech-to-text model is `gpt-4o-mini-transcribe`: `gpt-4o-transcribe` dropped the beginning and the end
  of phrases on test recordings.
- Latency percentiles in `/status` count only the first message of a burst.

### Fixed

- "Recorded" is shown by the gateway again (✍). Telegram's checkmarks, used for that in 0.2.0, appear even while the
  gateway is stopped, so they did not prove that a message was stored.

## 0.3.0 - 2026-10-21

### Added

- The agent can look at photos, screenshots sent as files and video-note frames with the new MCP tool `media(seq)`; the
  image comes back as MCP image content, and the file path is never exposed. Photos use the size closest to 1600 px;
  image files up to 3.75 MB (5 MB in base64), larger ones fall back to Telegram's thumbnail. Images of earlier messages
  can be opened after a reconnect; content past its retention period is reported as deleted. Database schema v8.
- Text inside an image is material, not instructions: images are labelled untrusted, and the channel instructions say
  so.
- Video notes and mp4 videos are transcribed by the configured speech-to-text provider.
- The owner's own (not forwarded) audio files and video notes count as the owner's words; forwarded ones remain
  untrusted material.

## 0.2.0 - 2026-10-21

### Added

- Pinned status line in the owner's private chat, edited in place: episode number and topic (`📍 #7 · topic`, or the last
  closed episode), and a second line of icons — agent 🟢 idle, 🟡 working, ⚪ offline, 🔴 model failure; `📥 N` waiting;
  🧠 context used (🌀 while compacting); 🕐 5-hour and 📅 weekly usage limits, with ⚠ and the reset time above 80 %.
- Agent state from Claude Code: `stg agent-state statusline` and `stg agent-state hook` (`PreCompact`, `PostCompact`,
  `StopFailure`) write `agent-state.json`, which the gateway watches. The agent folder template enables them with
  `start.sh --settings` and keeps an existing status line command (`--statusline-then`).
- Model failure notice: when the agent's model cannot answer (access disabled, rate limit and so on), the owner gets one
  line with what the model said, at most once an hour for the same error.
- Audio files (m4a, mp3, wav, ogg, flac, aac, webm and others) up to 15 minutes are transcribed right away
  (`stt.audio_max_minutes`); longer files are kept, and files over 20 MB cannot be downloaded by a bot. The duration is
  read from the file itself. Voice messages and audio files have separate transcription queues.
- `/help` command and a command menu with emoji labels.

### Changed

- Receipts are reactions instead of messages: 👀 when a message has reached the agent, 👌 when the agent replied or
  marked it done; Telegram's checkmarks stand for "received". Reactions have their own send lane, and an older
  reaction never replaces a newer one.
- Commands from a one-row bottom keyboard (where · new topic · pause · stop); command messages are deleted after
  execution, the "where" answer after 5 minutes; no extra lines on episode changes.
- Lines for the owner show the episode as `#N` and hide the default role.
- The agent's instructions explain that event numbers skip items not handed to the agent (button presses, commands), so
  a gap is not a lost message.

### Fixed

- When the agent's model refused to answer, the gateway only saw a failed channel check and the owner got no reason;
  the model failure notice (above) now says what happened.

## 0.1.0 - 2026-10-18

First version: one owner, one bot, one Claude Code agent on macOS.

### Added

- Gateway service `stg-gateway` (macOS LaunchAgent) that owns the bot's long polling. Every update is written to SQLite
  (WAL, full fsync) and its files to `raw/` before the next `getUpdates` acknowledges it to Telegram. Duplicates are
  detected by `update_id`; an update that crashes the gateway three times is deferred and kept; a full disk pauses
  intake instead of crashing; one instance per bot; sleep and wake-up are handled.
- Trust labels on every event: the owner's own words versus forwarded, untrusted or mixed material. Edits arrive as new
  events; closed topics and a closed marker word bypass the agent. Untrusted text cannot imitate event headers, and
  agent text cannot get into gateway lines.
- Sender: at most one message per second per chat, Markdown → Telegram HTML, splitting into parts of at most 4096
  characters on grapheme boundaries, retries on 429 and 5xx, "typing…" while the agent works, replies threaded to the
  right message.
- Owner commands, as words or slash commands: where, new topic, stop, pause, continue, status. Stop drops the agent's
  pending replies; pause holds what the agent says on its own initiative.
- Episodes (topic × role): closed after 33 minutes of silence, on "new topic" or on a Telegram topic change. The agent
  names or starts an episode, the owner confirms or rejects it with buttons; the agent writes episode summaries.
- Gateway ⇄ adapter protocol over a local Unix socket: a lease confirmed by a channel check with a one-time code,
  ping/pong, at-least-once delivery, redelivery after 10 minutes (postponed at most three times while the agent is busy),
  idempotent `reply`.
- `stg-channel`, an MCP server for Claude Code Channels, with the tools `reply`, `done`, `episode`, `episode_summary`,
  `where` and `rule`.
- Agent folder template: role instructions (`CLAUDE.md`), `.mcp.json`, `.claude/settings.json` (`dontAsk` with an
  allow-list) and `start.sh` with its own `CLAUDE_CONFIG_DIR`.
- Voice: transcription after the message is stored, replies by voice (`sendVoice`, Ogg/Opus), swappable providers —
  OpenAI-compatible (OpenAI by default; OpenRouter for transcription only) and ElevenLabs — configured independently
  for `stt` and `tts`, keys in the macOS Keychain; retention periods and a daily cleanup. Provider keys and the bot
  token never reach the logs, not even partially; URLs with credentials are rejected in `config.yaml`.
- Access rules: `rules.yaml` with subjects and chats. The agent's `rule` tool narrows access at once; widening needs
  the owner's button. The owner cannot be removed. Every change is logged and reported to the owner; manual edits of
  `rules.yaml` are picked up on restart.
- CLI `stg`: `doctor`, `status`, `where`, `rules show`, `backup`, `restore`, `deferred list` / `retry`, `log tail`,
  `service plist`, `agent-folder`.
- `scripts/install-macos.sh` and `scripts/uninstall-macos.sh`.
- Test fakes for the Telegram Bot API, the channel adapter and both speech provider dialects; a fake clock and fault
  injection points.

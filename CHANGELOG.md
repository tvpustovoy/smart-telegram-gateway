# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, any minor or patch release may change behavior,
the chat interface and the database schema. Schema migrations run automatically when the gateway starts; going back to
an older version after a migration is only possible from a database backup taken before the upgrade (`stg backup`).

The chat interface and the design documents are in Russian; the entries below describe behavior in English.

## Unreleased

### Added

- Install with your agent: `INSTALL.md` is written for Codex or Claude Code — the owner gives the agent the repository
  link, the agent installs the gateway for itself and asks the owner only for the bot, the token (typed into the
  Keychain by the owner) and the first message. `scripts/install-macos.sh --harness codex --agent-dir <folder>` installs
  the gateway for an existing Codex agent without touching its folder and prints how to start `stg-codex` in a visible
  window.
- Codex adapter, a prototype (#55): `stg-codex` (`packages/codex`) connects an existing Codex agent to the gateway.
  It takes the gateway's lease with the same client as the Claude Code channel and keeps a child `codex app-server`
  (JSON-RPC over stdio) with one thread for the conversation. Every waiting event goes to Codex as one `turn/start`
  input in the channel's header format; an event that arrives while a turn runs is added to that turn. `delivered`
  (👀) is sent only after Codex accepted the input. The agent's eight tools are given to Codex as dynamic tools and run
  through the channel's own `callTool`, with the gateway turn of the Codex turn.
- The agent is used as it is: Codex runs with the user's own settings and ChatGPT login (`CODEX_HOME` is not set), the
  model from the user's config and the agent's `AGENTS.md` from its folder. The adapter writes nothing into the
  agent's folder. The gateway's channel rules for Codex go into the thread's developer instructions, at thread start
  and on every resume. Permissions are basic: the `workspace-write` sandbox in the agent's folder plus the gateway's
  parcels folder as a writable root, no network for commands, approval policy `never` (approval requests, if any, are
  declined).
- Parcels for a Codex agent stay outside its folder: `parcels.dir` from `config.yaml`, otherwise `<bot dir>/parcels`
  (the adapter names the bot directory as the session directory to the gateway).
- The adapter closes the channel check itself, without a model turn. "Stop" interrupts the running turn
  (`turn/interrupt`), and a late tool call from it is refused without reaching the gateway; the stop, pause and
  continue lines go first in the next input. A turn that ends without `reply`, `done`, `send_file` or an episode summary
  for one of its events gets one reminder. A failed turn is retried; a lost login, a usage limit or a rate limit is
  reported to the owner once. A crashed `app-server` is restarted with a pause of 1–30 s and the thread resumed, and
  the events of the unfinished turn go again marked as a repeat after a Codex failure; if Codex stays down for a
  minute, the lease is given up. A thread is replaced only when Codex no longer has it. Without a ChatGPT login there
  is no lease, and the reason is in the feed and in `state.json`.
- Codex gets only events the gateway handed to the current lease. After a new lease (a reconnect, or the lease given
  up and taken again) a waiting event goes to Codex when the gateway hands it to that lease again — once, without
  waiting for the owner's next message; the gateway's repeat of an event already waiting is not queued twice.
- "typing…" for the whole Codex turn (#55). Found on the live check: the agent answered at once with an interim reply
  ("Посмотрю, что у нас записано…, и дам пример") and kept working for about a minute in the same turn; the reply ended
  "typing…" and the pinned line showed 🟢, so the owner could not tell whether the agent was thinking or stuck. A new,
  optional adapter message `working {on, seqs?}`: while a turn runs, the adapter tells the gateway the event numbers of
  the turn, and the gateway keeps sending "typing…" every 4 s to their chats (and topics) — after an interim reply too,
  and past the 2-minute limit per event — and the pinned line shows 🟡. It ends on `working {on: false}`, on "stop" (in
  "stop" `working` has no effect), when the lease is lost (an adapter that drops off — at once), or after 15 minutes
  without a new `working` (the adapter went silent or the turn hung; journal `working_expired`). The Codex adapter sends
  it when Codex accepts `turn/start` (a new turn or input added to the running one — at once), repeats it on signs of
  life from Codex (thread notifications, tool calls) at most every 30 s, and sends `on: false` on `turn/completed` and
  on "stop". Only a verified lease; only messages already handed to the agent (this lease or an earlier one); others are
  skipped. It is not a tool call, so it does not postpone redelivery. The Claude Code channel does not send it, and its
  "typing…" is unchanged. A gateway without `working` answers `bad_request`, and the adapter stops sending it.
- 👀 stays on the owner's message for the whole Codex turn that handles it (#55 with #52). Found on the live check: asked
  for a picture, the agent answered at once with an interim "Нарисую…" and drew for about two minutes; the interim reply
  removed 👀 (#52: the answer is its own sign), so nothing in the chat showed that the agent was still on it. Now an
  answer (`reply`, `send_file`) to an event that the running turn holds (it is in the last `working {on: true}`) does
  not remove the reaction — it may be interim; the journal's `out` line says `receipt_held`. The reaction goes when the
  turn lets the event go — `working {on: false}`, a new set without it, "stop", the lease lost, or the 15-minute limit —
  if an answer to it went out (journal `receipts_released`); an answer still waiting to be sent is handled by the sender
  as before. `done` inside a turn still puts 👌 at once, and the end of the turn does not remove it. The reaction lane
  keeps its order (removals last). A gateway restart in the middle of a turn: the turn lives in memory, so at start the
  gateway removes 👀 from processed events whose answer went out — without a turn such a 👀 does not exist (only 👀, within
  7 days; 👌 of earlier versions is not touched); journal `start.receipts_released`. The same runs after the disk
  recovers. The Claude Code channel does not send `working`, so nothing changes there.
- What the chat header shows while the turn works (#55). Found on the same live check: the agent drew a picture for two
  minutes under "typing…". `working` takes an optional `action`: `typing` (the default, also without the field),
  `upload_photo` ("sending a photo…") or `upload_document` ("sending a file…"); the gateway sends `sendChatAction` with
  it to the chats of the turn, at once when it changes. The Codex adapter sets `upload_photo` while Codex generates an
  image (the turn item `imageGeneration`, from `item/started` to `item/completed`, or the end of the turn) and goes back
  to `typing` after it; the feed says "рисует картинку…" and "картинка готова". While a turn runs and the gateway
  uploads one of the agent's parcels to that chat, the header shows `upload_document` or `upload_photo` (by how it is
  sent) instead, then the turn's action again. An event without a turn always shows `typing`. A gateway that does not
  know `action` answers `bad_request` ("нераспознанный ключ"), and the adapter sends `working` without it.
- A new Codex thread when the gateway's tools change (#55). `thread/resume` takes no tools, so a thread keeps the tools
  it was started with: after #60 the live agent still had `send_file` without `as` and told the owner that sending as a
  photo was not available. The adapter keeps a hash of the tool schema (names, descriptions, input schemas) in
  `state.json` (`toolsHash`). At start, if the hash differs — or is missing, as in a state file from before this change
  — and there is a thread, the adapter does not resume it: it starts a new thread with the current tools, keeps the old
  id as `previousThreadId` and says "инструменты шлюза изменились — новый тред Codex (прежний: …)" in the feed and the
  log. The old thread stays in the Codex history; the new one starts without the earlier conversation.
- The adapter's own lines in a Codex input start with `[адаптер · …]`. Text in an event that looks like one is
  written with a full-width bracket («［адаптер»), as the channel already does for `[№` and `[шлюз`, so forwarded
  text cannot pass as an adapter line; the channel rules for Codex say so.
- Adapter state — thread id, agent folder, version of the channel rules, unanswered events — is kept in
  `<bot dir>/codex/state.json` (written atomically), so a restart continues the same thread.
- A live feed for a terminal window on the adapter's stdout: incoming messages with their headers, turns, commands,
  file changes, reasoning summaries, tool calls and replies, token usage per turn; no probe codes or command output.
  The technical log is on stderr.
- `scripts/codex-agent-start.sh --agent-dir <folder>`: starts the adapter in a new iTerm window (Terminal if there is
  no iTerm), or `--here`, `--tmux`, `--print`; the log goes to `<bot dir>/codex/adapter.log`.
- Tests: a fake `codex app-server` (`test/fake-codex`) with a scripted model, unit tests of the adapter and an
  integration suite with the real gateway and the fake Telegram (boot, turn and reply, steering, stop and continue,
  reminder, media, parcels, usage limit, app-server crash, adapter restart, vanished thread, changed tools, Codex down
  for longer than a minute and the lease taken again, no login, "typing…" and 👀 through a long turn with an interim
  reply and on "stop"), and `working` against the gateway with a fake adapter (past an interim reply and 2 minutes, 🟡,
  off, the 15-minute limit and its extension, "stop", an adapter that drops off, foreign numbers, an unverified lease; 👀
  held through the turn and removed by its end, a new set, "stop", a dropped adapter, the limit and a gateway restart;
  `done` inside a turn; an answer without a turn as before; `working.action`, and "sending a file…" while a parcel
  uploads during a turn), "sending a photo…" while the fake Codex generates an image, and a turn longer than the
  gateway's 15-minute limit: with signs of life from Codex the adapter repeats `working` and "typing…" stays, without
  them the gateway drops it (the adapter's repeat interval is set under test with `STG_TEST_CODEX_WORKING_REPEAT_MS`).
  `test/e2e/dist/drill-codex.js` runs the same against the real `codex app-server` with one owner message.
- Pictures as photos (#60; the owner asked for a picture "not as a file, but as a picture"). `send_file` sends a picture
  — `jpg`, `jpeg`, `png` or `webp` within Telegram's photo limits (at most 10 MB, width plus height at most 10,000, the
  long side at most 20 times the short one) — as a photo (`sendPhoto`), so it shows in the chat as a picture; anything
  else still goes as a document. The gateway reads the format and the size from the file's header, with no new
  dependencies; a GIF, or a file whose size cannot be read, goes as a document.
- `send_file(…, as: "file" | "photo")`. `"file"` sends a picture as a document, the original without compression (for
  when the owner asks for a file or the original). `"photo"` asks for a photo explicitly: if the picture does not fit,
  it goes as a document and the tool says why. Without `as`, a picture goes as a photo and anything else as a document.
- If Telegram rejects the photo (400 or 413: `PHOTO_INVALID_DIMENSIONS`, `IMAGE_PROCESS_FAILED`,
  `PHOTO_SAVE_FILE_INVALID`, too large), the same delivery goes again as a document, with the same caption and reply,
  instead of failing: one delivery, the reason in its note and in the journal (`photo_rejected`). If the document is
  rejected too, the delivery fails as before, with one line to the owner. Caption, `↪ Name`, `⚙ обновлено`, stop,
  pause, turn, retries, 429 and the upload time limit work as for documents. The journal's `out` line for a parcel
  names the method (`sendPhoto` or `sendDocument`).

### Changed

- `stg-channel` exports what another adapter needs: `GatewayClient`, `gatewayFromEnv` (socket, time zone, timings and
  the parcels folder from `config.yaml` in one place), `instructionsFor('claude' | 'codex')`, `toolsFor('claude' |
  'codex')` and an optional `turn` in the tool call context. The Claude Code text of the channel rules is unchanged
  byte for byte, so `INSTRUCTIONS_VERSION` stays the same (a test pins its hash).
- Database schema v14 (#60): `deliveries.send_as` (`document` or `photo`). The choice is made at `send_file` and
  stored, so a retry after a failure or a restart goes the same way; deliveries from earlier versions are `document`.
- Channel rules, tool description, `/help` and the agent folder template (#60): pictures come as photos; `as: "file"`
  when the owner asks for a file or the original. Unlike the Codex split above, this changes the Claude Code text of the
  channel rules, so `INSTRUCTIONS_VERSION` is new (the pinned hash is updated on purpose): a resumed conversation gets
  the current rules once as a "channel rules" event. The Codex text changes the same way and reaches a resumed Codex
  thread too (the rules go with every resume), but the tool descriptions do not: Codex takes the agent's tools only at
  `thread/start`, not on `thread/resume`. The adapter therefore starts a new thread when the tools change (above), so a
  Codex thread started before this change is replaced by one with `as`. An agent folder deployed earlier needs the new
  line in its `CLAUDE.md` by hand (see the template README). A gateway from before this change does not know `as` and
  answers `bad_request`; the channel then tells the agent to send the file again without `as`.

## 0.3.6 - 2026-10-22

### Added

- A window for material without the owner's words (#51). Material is an owner's message with none of the owner's own
  words in it: a forward (of anything, including the owner's own old message), a message sent through an inline bot, a
  message with nothing but links, a photo, file or video without a caption, a location or contact. Until 0.3.6 it
  reached the agent at once, and the agent had to guess what to do with it, while the owner was usually about to say.
  Now such an event is stored at once but held (`held`, as the reaction undo window of 0.3.4 holds a reaction: same
  status, `hold_until`, exact timer, the rest of the window counted after a restart) for `ui.material_hold_seconds`
  (default 60, `0` turns the window off, at most 600; #51: one minute rather than two).
- Words release the window: the owner's next message with their own words in the same chat and Telegram topic — text,
  a caption, a voice message, a video note, their own audio file — releases all held material of that chat in the same
  transaction that stores the words. The agent gets the material and the words in one go, in order: material first,
  each with the header mark `слова владельца — следом, № M`.
- Three rules of the window: (1) a voice message or video note counts as words the moment it arrives, not after
  transcription — the material does not overtake it and does not wait for the window: it stays held until the voice
  message is transcribed and then goes right before it; (2) several pieces of material in a row share one window,
  counted from the last one; (3) material that comes after the owner's words in the same chat within the window goes at
  once, marked `слова владельца — раньше, № K`.
- An owner's message with nothing but links is material without words. This is how a page shared from the browser
  ("Share" → Telegram) arrives: an ordinary text message from the owner holding only the link — not a forward and not an
  inline bot, so the window used to miss it. A link is `http(s)://…`, `www.…` or `t.me/…`. It ends the way Telegram ends
  it: a trailing `.` `,` `;` `:` `?` `!` `)` `»` `"` `'` is not part of it; an emoji, `«`, `»`, `<`, `>`, a space or an
  invisible character cuts it; after the domain (and port) only `/`, `?` or `#` continue it, so
  `https://a.com,посмотри`, `https://a.com🔥` and `https://a.com?` are words; inside the path a comma is part of the
  link, as in Telegram (`https://a.com/a,b`); Cyrillic in the address (`…/wiki/Сон`) is part of the link. Spaces, line
  breaks, invisible characters (zero-width, LRM and RLM, U+FFFC) and separating punctuation around the links (commas,
  periods, brackets, quotes, dashes, list bullets) do not count. Such a message is
  held like any material: it goes with the owner's next words (`слова владельца — следом, № M`) or after the window
  (`слов владельца не было за 1 мин`); it does not release the window and is not "words after material"; several link
  messages share one window; words sent just before it make it go at once (`слова владельца — раньше, № K`); a reply to
  it is `слова к материалу № N`; an edit of a held link to another link waits with it, an edit that adds words releases
  the window. A caption of only links on a photo or file is no words either. Any other word next to a link — `посмотри
  https://…`, a page title above the link — makes it the owner's words, as before: a page title cannot be told from the
  owner's words (the Bot API does not give the preview title), and a link on words (`text_link`) shows words. The
  decision reads the text only, not Telegram's `url` entities: they are not stored, and the same decision is made again
  from the stored event (a reply to material, words before material, words after material), so a domain without `www` or
  a scheme (`example.com/…`) stays words. With the window off (`0`) a link goes at once, as before.
- A message of only links sent as a reply to an agent message is the owner's answer to the agent, not material (the
  agent asked for a link, the owner answered with it): it goes at once as the owner's words — `слово владельца · ответ
  на твоё сообщение к № N`, with no material marks and no `ссылка владельца`. It neither opens nor releases the window:
  it answers the agent, not the material, so held material keeps waiting and its window is not extended; it is not
  "words before" (rule 3) or "words after material" and does not take the place of the first words. The decision is
  made at intake and again from the stored event the same way (`reply_to` is stored with the event): a reply to such an
  answer is `ответ на своё сообщение`, not `слова к материалу`. A photo, file, forward, inline-bot message or a caption
  of only links sent as a reply to the agent is material, as before.
- A window that ends without words releases the material marked `слов владельца не было за N мин` (how long it
  actually waited).
  A forwarded voice message is material too: it is transcribed as before, and if the window is still open, it is held
  again afterwards. An edit of held material counts as words only if it carries the owner's words (a caption added). An
  edit without words — a live location sending new coordinates, a photo replaced without a caption — does not release
  the window and does not extend it: it is held with its original, with the same deadline, and goes right after it.
- If the material's episode closes before any words come (`новая тема`, the agent starts a new topic, another Telegram
  topic, silence), the held material is released in the same transaction, marked as having no words, before the
  "episode closed" event — the agent writes the episode summary having seen it.
- Commands (`стоп`, `где мы`, …) and button presses are not words; a sticker, dice or GIF neither opens nor closes the
  window. `стоп` works as before: the window runs, then the material waits in `new` for [продолжить]. Messages of other
  participants are not held.
- The owner's words to material after the window. A reply to material, at any time, reaches the agent as
  `слова к материалу № N` instead of `ответ на своё сообщение № N`: the gateway marks `reply_to.material` when the
  replied message is material (an event the window handled, or material by the same classification when the window is
  off or the message predates 0.3.6). A reply within the window releases the material as any words do; the material is
  marked `слова владельца — следом, № M` and the reply `слова к материалу № N`.
- Words after material: the owner often sends material and records a voice message about it separately, which may miss
  the window. After material has gone out marked as having no words, the owner's first next message with their own
  words (text, voice message, video note, caption) in the same chat, Telegram topic and episode, no later than
  `ui.material_followup_minutes` after the material was released (default 10, `0` turns it off, a whole number up to
  120), reaches the agent marked `слова после материала № N` (`№ N, K` for several). Only the first such message; a
  voice message counts from its arrival, not from its transcription. A reply to material takes priority: it is marked
  `слова к материалу`, not `после`, and it still counts as the first words. The link is stored with the material
  (`material_json.followup_seq`) and survives a restart.
- 👀 is set when the material is given to the agent, that is after the window: 👀 still means "the agent has seen it".
- `where` (owner, agent, `stg where`): the line `Ждут слов владельца: N (№ …)` lists held material — N is the total,
  the numbers are the first ones; the fields `held_material` (first 50) and `held_material_count` in the where data.
  Edits held with their original are not listed.
- Event frames carry the optional field `material {words: after | before | none, words_seq, waited_ms}`; the channel
  turns it into the header mark (`meta.material`, `meta.words_seq`). Words to material carry the optional
  `reply_to.material` (`meta.to_material`) or `after_material` (the material numbers; `meta.after_material`). An older
  channel drops these fields and shows the event without the mark. The owner's own photo, file or video without a
  caption that carries the mark is labelled `чужое (фото)` rather than `слово владельца + чужое (фото)`, with
  `meta.trust` `untrusted` and `meta.mixed` `false`: there are no owner's words in it. The owner's own message of only
  links that carries the mark is labelled `ссылка владельца` (`ссылки владельца` for several) — sent by the owner, but
  not `слово владельца` next to `слов владельца не было` — also with `meta.trust` `untrusted` and `meta.mixed` `false`;
  the label stored in the database and sent in the frame stays `owner`. Without the mark (window 0) the label is as
  before.
- Journal: `in` with `material: held | words_before` (`joined` for an edit held with its original), `after_material`
  and `reply_to_material` for words to material, `material_released {seq, held_ms, words, words_seq?,
  episode_closed?}`, `material_linked {seq, words_seq}` (released by a voice message still being transcribed),
  `material_held` (a transcribed forwarded voice message back in its window).
- Role rules (channel instructions and the agent folder template): "Material (link, forward, file, picture) comes
  together with the owner's words — answer the words. If it comes marked that there were no words from the owner — the
  gist in 3–5 lines and one question"; for episodes: "An unrelated matter came up — open a new episode yourself, without
  asking; the owner will correct it with [не то]. Stay only if the new thing may belong to the current topic; material
  along the way (a link, a forward) stays in the same episode." The line about `done` is narrowed so it does not
  contradict the material rule: `done` is for material that came together with the owner's words (done on the material,
  reply to the words), "just note it", the channel check and the episode summary — no longer "only material: a forward,
  a file", which would let the agent close wordless material silently. For words to material after the window: "The
  owner's reply to material is their words to that material, at any time: answer them with the material in mind" and
  "Words after material No. N are the owner's words to that material: answer them with the material in mind; the short
  gist has already gone out, do not repeat it." Among the labels: "`ссылка владельца` (`ссылки владельца`) — the owner's
  link without their words: material"; the agent folder template also lists it among the labels of a note. The
  instructions have a new version, so a resumed conversation gets them as a "channel rules" event (0.3.5).
- `scripts/agent-folder/README.md`: what to change by hand in an agent folder deployed before 0.3.6 (the `done` line,
  the material rule, the two lines on words to material after the window, the episode rule, the `ссылка владельца`
  label, the reactions line and the `чужое (№ N)` rule below).
- The bot's receipt goes away once it has served (#52; `ui.clear_receipts`, default `true`). A reaction on the owner's
  message now lives while the owner waits for an answer:
  - When the agent answers an event — `reply(seq)` or `send_file(seq)` — the gateway no longer sets 👌: it removes its
    reaction (`setMessageReaction` with an empty list) once the answer has reached Telegram — every part of a long
    answer, the document of a parcel — and not before; until then the message keeps 👀. The answer itself is the sign.
    Removing the bot's reaction also clears the owner's unread-reaction mark in the chat list (checked on a live chat).
  - `done` (closed without an answer) still sets 👌. The owner's next message in that chat — any new message: text,
    voice, photo, forward, a command word too; not a button tap, a reaction or an edit — removes every "closed without
    an answer" 👌 the bot set on the owner's messages there within the last 7 days, in the same transaction that stores
    the message. Older history is not walked, and nothing is removed when the gateway starts; a restart between `done`
    and the next message does not lose the removal (the state is in the `reactions` table).
  - Upgrading: a 👌 on a message whose answer was sent (that is how 0.3.5 and earlier marked every answered message,
    and how `ui.clear_receipts: false` still does) is not a "closed without an answer" mark, so the next message leaves
    it as it is. The first message after the upgrade removes only the 👌 of `done` and of dropped answers, not a 👌 on
    almost every message of the past week (found in review: one message would otherwise send hundreds of
    `setMessageReaction` calls in a row).
  - In the reaction lane, removals go after 👀 and 👌: a new message's 👀 no longer waits behind a queue of removals,
    only behind a removal already in flight.
  - An answer that never reached the chat (dropped by `стоп`, refused by Telegram, a parcel copy gone) leaves the event
    closed with no answer in the chat: the message gets 👌 instead of a 👀 that would otherwise stay forever, and the next
    message removes it. `стоп` is itself the owner's next message: it removes the earlier 👌 first, then drops the
    answers; [продолжить] is a button tap and removes nothing.
  - Done with the existing `reactions` row and its retry queue: removing is an empty `want`, as for an edit since
    0.3.2, so a Telegram error on removal is retried like any reaction. No schema change (still v13). The text receipt
    of early builds is long gone (`fallback_at`, `fallback_sent` are not written), so there is nothing to delete.
  - `ui.clear_receipts: false` keeps the previous behavior: `reply` and `send_file(seq)` set 👌 at once, and 👌 stays.
  - `/help`, the channel instructions and the agent folder template say what the reactions mean now ("you answered —
    the gateway removes the reaction: the answer itself is the sign; 👌 — you marked it `done` without an answer"); the
    instructions have a new version, so a resumed conversation gets them as a "channel rules" event (0.3.5).
  - Journal: `out.receipt_cleared` (an answer removed the reaction), `in.receipts_cleared` (how many 👌 the owner's
    message removed), `send_dropped.receipt: 👌` (an answer that did not go out).

### Changed

- License: Apache License 2.0 (`LICENSE`, `NOTICE`); `CONTRIBUTING.md` added.
- Database schema v13: the `events` table is rebuilt with the column `material_json` (on `text`, `voice`, `photo`,
  `document`, and on `edit` for an edit held with its original); `held` is allowed for material as well as for
  reactions, `cancelled` stays reaction-only. Going back to 0.3.5 is possible only from a backup taken before the
  upgrade.
- `packages/gateway/src/reaction-hold.ts` is now `hold.ts` (`Hold`): one timer for both windows.
- Agent folder template, the `чужое (№ N)` rule: a note made from the content of a page behind a link gets
  `чужое (№ N)` too; the owner's link itself needs no mark.
- Tests: test homes write `ui.material_hold_seconds: 0` unless a test asks for the window, so tests written before
  0.3.6 keep sending captionless photos and forwards straight to the agent; the window has its own suite
  (`m11-material-hold`), which also runs a picture scenario of the earlier suites (`media(seq)`, 👀, then 👌 on the
  photo closed with `done` and the reaction removed from the words the agent answered) and a new topic during the
  window with the default window, and covers replies to material and words after material (A11.23, A11.24), messages of
  only links (A11.25) and a link sent as a reply to the agent (A11.26). Receipts have their own suite
  (`m12-receipts-clear`, A12.1–A12.9); suites that waited for 👌 after a reply now wait for the reaction to be removed;
  the latency test A1.6 runs with `ui.clear_receipts: false` (in a stream of one message a second every next message
  would remove the previous 👌).

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

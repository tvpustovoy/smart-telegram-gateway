// Посылки (TECH-SPEC 5.16; 0.3.3; P-23, issue #29): агент отвечает файлами. Файлы лежат в промежуточной папке, которую
// агент обновляет сам; устройство оставляет место, чтобы позже добавить публикацию посылок в веб-сервис
// (P-32, issue #35).
//
// - Папка посылок — единственное место, откуда агент отдаёт файл наружу: parcels.dir из config.yaml или
//   `<каталог сессии агента>/parcels` (session_hint.cwd канала — папка агента, рядом с notes/). Посылка — её подпапка
//   `<имя>/` с файлами; агент создаёт и обновляет их сам (шаблон папки агента разрешает запись в parcels/).
// - send_file(path) — путь внутри папки посылок. Шлюз проверяет: realpath внутри папки (симлинк наружу — отказ),
//   скрытых сегментов нет (.git, .env …), обычный файл, одно имя (жёсткая ссылка — отказ: по ней не узнать, не чужой ли
//   это файл), не пустой, не больше 50 МБ (предел бота через общий сервер Bot API). Файл открывается один раз (O_NOFOLLOW,
//   O_NONBLOCK — FIFO не держит шлюз), проверки и чтение — по дескриптору; путь после открытия — тот же файл (inode).
// - Копия — в хранилище шлюза `raw/parcels/<sha256>` (временный файл → fsync → переименование); одна версия — одна
//   копия. Повтор отправки (сбой Telegram, перезапуск шлюза) берёт копию, а не файл агента: правка или удаление
//   исходника на доставку не влияют. Копия пишется до транзакции, синхронно (до 50 МБ — доли секунды) ⟨предл.⟩: между
//   снимком и записью ничего не вклинивается; упали между ними — копия без ссылки, её уберёт суточная чистка.
// - В той же транзакции, что строка очереди цели (у telegram — outbox), — строка доставки (deliveries): посылка, файл,
//   версия (SHA-256), цель, чат, статус pending; повтор той же версии можно (агенту — «уже отправлял N») ⟨предл.⟩; новая
//   версия того же файла — владельцу «обновлено» ⟨предл.⟩.
// - Цели доставки — расширяемая точка (DeliveryTarget): имя · проверка · доставить · где смотреть. Сейчас одна —
//   telegram (sendDocument через очередь отправителя: стоп, ход, повтор, 429 — как у ответа агента). Веб-публикации нет:
//   её место — имя цели в parcels.targets и поле deliveries.url (5.16, «Дальше: веб-публикация посылок»).
// - Куда: личка владельца — всегда; другой чат — только если его правило в rules.yaml разрешает (parcels: true) ⟨предл.⟩.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PARCEL_TARGET,
  PARCELS_DIR_NAME,
  PARCEL_MAX_BYTES,
  PARCEL_STORE_DIR,
  chatRuleFor,
  ensureDir,
  formatBytes,
  fsyncDir,
  hasHiddenSegment,
  hasUnsafeName,
  parcelPartsOf,
  parcelVersion,
  relativeInside,
  sql,
  transaction,
  type SendFileResult,
  type WriteIo,
} from 'stg-core';
import { insertOutbox, type Ctx } from './context.js';

/** Чем писать копию (под тестом — «диск полон», testhooks.ts). */
export interface ParcelHooks {
  fileIo(): WriteIo | undefined;
  /**
   * Точки модульного теста гонки «проверка — чтение» (parcels.test.ts): между проверкой пути и открытием файла и между
   * проверками по дескриптору и повторной сверкой пути. В шлюзе их нет.
   */
  beforeOpen?(real: string): void;
  beforeRecheck?(real: string): void;
}

/** Ключ повтора send_file (как у reply) смотрится за сутки. */
const IDEM_WINDOW_MS = 24 * 3600_000;
/** Кусок чтения файла при снимке. */
const CHUNK_BYTES = 1024 * 1024;

/** Отказ агенту — понятным текстом (bad_request); reason — в журнал send_file_refused. */
export class ParcelRefusal extends Error {
  constructor(
    readonly reason: string,
    text: string,
  ) {
    super(text);
  }
}

const refuse = (reason: string, text: string): never => {
  throw new ParcelRefusal(reason, text);
};

/** Что доставить — для цели. */
export interface DeliveryRequest {
  seq: number | null;
  chatId: number;
  threadId: number | null;
  /** Подпись (Markdown агента); пусто — без подписи. */
  caption: string;
  fromName: string | null;
  turn: number;
  /** Пауза: придержать до «продолжить». */
  held: boolean;
}

/**
 * Цель доставки (расширяемая точка, 5.16). Сейчас одна — telegram. Новая цель (веб-публикация посылок) — ещё одна
 * реализация с именем из parcels.targets: проверка (куда можно), доставка (в транзакции записи — поставить в свою
 * очередь) и «где смотреть» словами агенту в момент постановки. Адрес опубликованного (deliveries.url) у веб-цели
 * известен только после загрузки — его ставит её цикл отправки вместе со статусом sent, как отправитель Telegram ставит
 * tg_message_id (TECH-SPEC 5.16, «Дальше»); where().url — только если адрес известен заранее.
 */
export interface DeliveryTarget {
  readonly name: string;
  /** Можно ли доставлять в этот чат; строка — причина отказа агенту. Без записи. */
  check(chatId: number): string | null;
  /** Поставить в очередь — внутри транзакции записи доставки. outboxId — строка очереди отправителя (у telegram). */
  enqueue(req: DeliveryRequest): { outboxId: number | null };
  /** Где смотреть: словами для агента; url — адрес, если известен до отправки (у telegram — нет, сообщение в чате). */
  where(): { text: string; url: string | null };
}

/**
 * Telegram: документ в чат (sendDocument) через очередь отправителя (sender.ts) — та же строка outbox, что у ответа
 * агента (origin agent): «стоп» её бросает, ход проверен до записи, повтор после сбоя, 429 — как у ответа.
 */
export class TelegramTarget implements DeliveryTarget {
  readonly name = 'telegram';

  constructor(private readonly ctx: Ctx) {}

  check(chatId: number): string | null {
    // Личка владельца — всегда (номер лички — номер владельца).
    if (this.ctx.config.owner_id !== null && chatId === this.ctx.config.owner_id) return null;
    const rule = chatRuleFor(this.ctx.directory.rules, chatId);
    if (rule?.parcels === true) return null;
    return 'в этот чат файлы не отправляю: по умолчанию — только в личку владельца; другой чат — если владелец разрешил это в rules.yaml (parcels: true у правила чата)';
  }

  enqueue(req: DeliveryRequest): { outboxId: number | null } {
    const outboxId = insertOutbox(this.ctx, {
      eventSeq: req.seq,
      chatId: req.chatId,
      threadId: req.threadId,
      kind: 'agent',
      text: req.caption,
      origin: 'agent',
      turn: req.turn,
      status: req.held ? 'held' : 'pending',
      fromName: req.fromName,
    });
    return { outboxId };
  }

  where(): { text: string; url: string | null } {
    return { text: 'в чате Telegram', url: null };
  }
}

/** Папка посылок: как задана (для слов агенту) и настоящая (realpath — для проверок). */
interface Root {
  lexical: string;
  real: string;
}

/** Файл посылки после проверок. */
interface Resolved {
  real: string;
  parcel: string;
  file: string;
  name: string;
}

/** Копия в хранилище шлюза. */
interface Copy {
  bytes: number;
  sha256: string;
  /** raw/parcels/<sha256> — относительно каталога бота. */
  copyRef: string;
}

export interface SendFileInput {
  path: string;
  target: string | undefined;
  /** Каталог сессии агента (session_hint.cwd аренды): папка посылок по умолчанию — <он>/parcels. */
  leaseCwd: string | null;
  req: DeliveryRequest;
  idem: string | null;
  /** Ещё в той же транзакции: событие обработано (adapter.ts; 👌 — только при ui.clear_receipts: false, 0.3.6). */
  inTx?: () => void;
}

export type SendFileOutcome =
  | { ok: true; result: SendFileResult & { delivery: number }; outboxId: number | null; sha256: string }
  | { ok: false; reason: string; text: string };

/** «~/…» — от домашнего каталога. */
function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export class ParcelService {
  private readonly targets = new Map<string, DeliveryTarget>();

  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: ParcelHooks | null = null,
  ) {
    const tg = new TelegramTarget(ctx);
    this.targets.set(tg.name, tg);
  }

  /** Подключённые цели (реализованы в этой версии). */
  get known(): string[] {
    return [...this.targets.keys()];
  }

  /** Хранилище копий: <каталог бота>/raw/parcels. */
  get storeDir(): string {
    return path.join(this.ctx.paths.raw, PARCEL_STORE_DIR);
  }

  /** Цель по имени: подключена в этой версии и включена в config.yaml (parcels.targets). */
  private target(name: string): DeliveryTarget {
    const t = this.targets.get(name);
    if (!t) return refuse('target_unknown', `цель «${name}» не подключена в этой версии шлюза: есть ${this.known.join(', ')}`);
    if (!this.ctx.config.parcels.targets.includes(name)) {
      return refuse('target_off', `цель «${name}» выключена: её нет в parcels.targets в config.yaml — это решает владелец`);
    }
    return t;
  }

  /** Папка посылок: parcels.dir или <каталог сессии агента>/parcels; должна быть и быть папкой. */
  private root(leaseCwd: string | null): Root {
    const dir = this.ctx.config.parcels.dir !== null ? expandHome(this.ctx.config.parcels.dir) : leaseCwd ? path.join(leaseCwd, PARCELS_DIR_NAME) : null;
    if (dir === null) return refuse('no_root', 'папка посылок не задана: каталог сессии агента неизвестен — нужен parcels.dir в config.yaml');
    const lexical = path.resolve(dir);
    let real: string;
    try {
      real = fs.realpathSync(lexical);
    } catch {
      return refuse('no_root', `папки посылок нет: ${lexical} — создай её и положи посылку в подпапку: ${lexical}/<посылка>/<файл>`);
    }
    if (!fs.statSync(real).isDirectory()) return refuse('no_root', `${lexical} — не папка: папка посылок должна быть папкой`);
    return { lexical, real };
  }

  /** Путь агента → файл посылки (без открытия): внутри папки, без скрытых сегментов, обычный файл в подпапке. */
  private resolve(given: string, root: Root): Resolved {
    const g = given.trim();
    if (!g || g.includes('\0')) return refuse('bad_path', 'path — пустой или с нулевым знаком');
    const abs = path.isAbsolute(g) ? path.resolve(g) : path.resolve(root.lexical, g);
    const relLex = relativeInside(root.lexical, abs) ?? relativeInside(root.real, abs);
    const example = `${root.lexical}/<посылка>/<файл> (или от неё: <посылка>/<файл>)`;
    if (relLex === null) return refuse('outside', `путь вне папки посылок: отдаю только файлы из ${example}`);
    if (hasHiddenSegment(relLex)) return refuse('hidden', 'скрытые файлы и папки (.git, .env и другие с точки) не отправляю');
    if (hasUnsafeName(relLex)) return refuse('bad_name', 'в имени файла или папки управляющие или невидимые знаки — переименуй');
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return refuse('not_found', `нет файла ${relLex} в папке посылок ${root.lexical}`);
      return refuse('unreadable', `файл не открылся: ${code ?? (err as Error).message}`);
    }
    const rel = relativeInside(root.real, real);
    if (rel === null) return refuse('link_outside', `${relLex} — ссылка за пределы папки посылок: отдаю только сами файлы из неё`);
    if (hasHiddenSegment(rel)) return refuse('hidden', `${relLex} — ссылка на скрытый файл или папку: не отправляю`);
    const st = fs.lstatSync(real);
    if (st.isDirectory()) return refuse('directory', `${relLex} — папка: укажи файл в ней`);
    if (!st.isFile()) return refuse('not_file', `${relLex} — не обычный файл`);
    const parts = parcelPartsOf(rel);
    if (!parts) return refuse('no_parcel', `файл лежит прямо в папке посылок — положи его в папку посылки: ${root.lexical}/<посылка>/${path.basename(rel)}`);
    return { real, ...parts };
  }

  /**
   * Снимок: файл открывается один раз (O_NOFOLLOW — последнее звено не подменить симлинком; O_NONBLOCK — FIFO не держит
   * шлюз); проверки — по дескриптору; путь — тот же файл (dev, inode); читается из дескриптора с подсчётом SHA-256 сразу
   * во временный файл хранилища → fsync → переименование в raw/parcels/<sha256>. Та же версия уже есть — копия та же
   * (время файла освежается: чистка сирот его не тронет).
   */
  private snapshot(r: Resolved): Copy {
    this.hooks?.beforeOpen?.(r.real);
    let fd: number;
    try {
      fd = fs.openSync(r.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') return refuse('link_outside', `${r.parcel}/${r.file} — ссылка: отдаю только сами файлы`);
      if (code === 'ENOENT') return refuse('not_found', `нет файла ${r.parcel}/${r.file}`);
      return refuse('unreadable', `файл не открылся: ${code ?? (err as Error).message}`);
    }
    let tmp: string | null = null;
    let out: number | null = null;
    try {
      const st = fs.fstatSync(fd);
      const shown = `${r.parcel}/${r.file}`;
      if (!st.isFile()) refuse('not_file', `${shown} — не обычный файл`);
      if (st.nlink > 1) refuse('hard_link', `${shown} — жёсткая ссылка (у файла ${st.nlink} имени): по ней не узнать, не чужой ли это файл — положи в посылку копию`);
      if (st.size === 0) refuse('empty', `${shown} — пустой файл: Telegram пустое не примет`);
      if (st.size > PARCEL_MAX_BYTES) refuse('too_big', `${shown} — ${formatBytes(st.size)}: больше 50 МБ бот через Bot API не отправит — сожми или раздели файл`);
      this.hooks?.beforeRecheck?.(r.real);
      // Открыт тот же файл, что проверен: путь по-прежнему ведёт сюда же (ни одно звено не стало ссылкой) и к тому же
      // inode. Подменили звено пути на ссылку наружу до открытия — открылся бы чужой файл, а здесь расхождение.
      let again: fs.Stats;
      let realNow: string;
      try {
        realNow = fs.realpathSync(r.real);
        again = fs.lstatSync(r.real);
      } catch {
        return refuse('changed', `${shown} пропал во время проверки — повтори`);
      }
      if (realNow !== r.real || again.ino !== st.ino || again.dev !== st.dev) refuse('changed', `${shown} подменили во время проверки — повтори`);
      // И после сверки — дескриптор ещё раз (находка проверки): звено пути вернули настоящей папкой, а чужой
      // открытый файл положили в неё жёсткой ссылкой — путь и inode сходятся, но у файла теперь два имени.
      const st2 = fs.fstatSync(fd);
      if (st2.nlink !== 1 || st2.ino !== st.ino || st2.dev !== st.dev) {
        refuse('changed', `${shown} подменили во время проверки — повтори`);
      }
      const dir = this.storeDir;
      ensureDir(dir);
      tmp = path.join(dir, `.copy.${process.pid}.${Date.now()}.tmp`);
      out = fs.openSync(tmp, 'wx', 0o600);
      const io = this.hooks?.fileIo();
      const hash = crypto.createHash('sha256');
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      let total = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        total += n;
        if (total > PARCEL_MAX_BYTES) refuse('too_big', `${shown} вырос во время чтения больше 50 МБ — повтори, когда файл будет готов`);
        hash.update(buf.subarray(0, n));
        let off = 0;
        while (off < n) {
          const w = io ? io.writeSync(out, buf, off, n - off) : fs.writeSync(out, buf, off, n - off);
          if (!Number.isInteger(w) || w <= 0) throw Object.assign(new Error(`write: записано ${String(w)} байт`), { code: 'EIO' });
          off += w;
        }
      }
      if (total !== st.size) refuse('changed', `${shown} менялся во время чтения (было ${st.size} байт, прочитано ${total}) — повтори, когда файл будет готов`);
      fs.fsyncSync(out);
      fs.closeSync(out);
      out = null;
      const sha256 = hash.digest('hex');
      const final = path.join(dir, sha256);
      const have = fs.statSync(final, { throwIfNoEntry: false });
      if (have && have.isFile() && have.size === total) {
        fs.rmSync(tmp, { force: true });
        const now = new Date();
        fs.utimesSync(final, now, now);
      } else {
        fs.renameSync(tmp, final);
        fsyncDir(dir);
      }
      tmp = null;
      return { bytes: total, sha256, copyRef: path.posix.join('raw', PARCEL_STORE_DIR, sha256) };
    } finally {
      if (out !== null) {
        try {
          fs.closeSync(out);
        } catch {
          // уже закрыт
        }
      }
      if (tmp !== null) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // уберёт sweepTempFiles при следующем старте
        }
      }
      fs.closeSync(fd);
    }
  }

  /**
   * Тот же send_file уже принят (idem — ключ повтора, как у reply): связь оборвалась после отправки, канал прислал его
   * снова — второй доставки нет. Агенту — что стало с первым вызовом, по статусу доставки, а не по строке очереди цели
   * (у будущей веб-цели строки outbox нет): ждёт (queued, в паузе — held_paused), ушёл (sent), брошен «стопом»
   * (dropped_stopped), не ушёл (failed, note — почему); repeated — это исход прежнего вызова, ушла версия version
   * (находка проверки: агент мог поправить файл до повтора). null — такого ключа не было.
   */
  repeated(idem: string | null): (SendFileResult & { delivery: number }) | null {
    if (!idem) return null;
    const row = sql(this.ctx.db,
      `SELECT d.id, d.parcel, d.file, d.bytes, d.sha256, d.updated, d.target, d.status, d.note, o.status AS o_status
       FROM deliveries d LEFT JOIN outbox o ON o.id = d.outbox_id
       WHERE d.idem = ? AND d.created_at >= ? ORDER BY d.id LIMIT 1`,
    ).get(idem, this.ctx.clock.now() - IDEM_WINDOW_MS) as
      | {
          id: number;
          parcel: string;
          file: string;
          bytes: number;
          sha256: string;
          updated: number;
          target: string;
          status: string;
          note: string | null;
          o_status: string | null;
        }
      | undefined;
    if (!row) return null;
    const status =
      row.status === 'pending' ? (row.o_status === 'held' ? 'held_paused' : 'queued') : row.status === 'dropped' ? 'dropped_stopped' : row.status;
    return {
      status,
      delivery: row.id,
      parcel: row.parcel,
      file: row.file,
      bytes: row.bytes,
      version: parcelVersion(row.sha256),
      updated: row.updated === 1,
      target: row.target,
      repeated: true,
      ...(row.note ? { note: row.note } : {}),
    };
  }

  /**
   * Отдать файл: цель и чат → папка и путь → снимок → одной транзакцией строка очереди цели и строка доставки (и
   * inTx — событие обработано). Отказ — ParcelRefusal словами агенту; «диск полон» и прочие ошибки записи — наверх.
   */
  send(input: SendFileInput): SendFileOutcome {
    try {
      const target = this.target(input.target ?? DEFAULT_PARCEL_TARGET);
      const chatProblem = target.check(input.req.chatId);
      if (chatProblem) refuse('chat', chatProblem);
      const root = this.root(input.leaseCwd);
      const file = this.resolve(input.path, root);
      const copy = this.snapshot(file);
      const now = this.ctx.clock.now();
      const where = target.where();
      const r = transaction(this.ctx.db, () => {
        const sameFile = 'parcel = ? AND file = ? AND target = ? AND chat_id IS ?';
        const last = sql(this.ctx.db, `SELECT sha256 FROM deliveries WHERE ${sameFile} AND status IN ('pending', 'sent') ORDER BY id DESC LIMIT 1`).get(
          file.parcel,
          file.file,
          target.name,
          input.req.chatId,
        ) as { sha256: string } | undefined;
        const sentBefore = (sql(this.ctx.db, `SELECT count(*) AS n FROM deliveries WHERE ${sameFile} AND sha256 = ? AND status IN ('pending', 'sent')`).get(
          file.parcel,
          file.file,
          target.name,
          input.req.chatId,
          copy.sha256,
        ) as { n: number }).n;
        const updated = last !== undefined && last.sha256 !== copy.sha256;
        const { outboxId } = target.enqueue(input.req);
        const d = sql(this.ctx.db,
          `INSERT INTO deliveries(parcel, file, bytes, sha256, copy_ref, target, chat_id, event_seq, outbox_id, status, url, updated, idem, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        ).run(
          file.parcel,
          file.file,
          copy.bytes,
          copy.sha256,
          copy.copyRef,
          target.name,
          input.req.chatId,
          input.req.seq,
          outboxId,
          where.url,
          updated ? 1 : 0,
          input.idem,
          now,
        );
        input.inTx?.();
        return { delivery: Number(d.lastInsertRowid), outboxId, sentBefore, updated };
      });
      return {
        ok: true,
        outboxId: r.outboxId,
        sha256: copy.sha256,
        result: {
          status: input.req.held ? 'held_paused' : 'queued',
          delivery: r.delivery,
          parcel: file.parcel,
          file: file.file,
          bytes: copy.bytes,
          version: parcelVersion(copy.sha256),
          sent_before: r.sentBefore,
          updated: r.updated,
          target: target.name,
          where: where.url ?? where.text,
        },
      };
    } catch (err) {
      if (err instanceof ParcelRefusal) return { ok: false, reason: err.reason, text: err.message };
      throw err;
    }
  }
}

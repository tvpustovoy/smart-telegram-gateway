// Картинки для агента — инструмент media(seq) (0.3; P-6, P-14; TECH-SPEC 5.15): фото, скриншоты, кадры кружков и видео.
//
// Агент видит само изображение: канал вызывает `media {seq}`, шлюз отвечает картинкой в base64 (MediaResult, protocol.ts),
// канал отдаёт её модели содержимым MCP вида image — Claude Code показывает модели картинки из ответов инструментов,
// и прав на чтение файлов вне папки агента не нужно. Что показывается — core/media.ts (viewableOf): фото — размер ближе
// к 1600 px; изображение файлом — сам файл до 3,75 МБ ⟨предл.: 5 МБ в base64⟩, больше — уменьшенная копия Telegram с
// пометкой «слишком большое для просмотра» (уменьшать своим кодом нечем — новых программ нет); кружок и видео —
// кадр-обложка Telegram.
//
// Файл скачивается по первому запросу (getFile, предел Bot API 20 МБ, срок 60 с по часам шлюза ⟨предл.⟩) и кладётся в
// raw/<дата события>/<update_id>.<вид>.<расширение> (вид: media — сам файл, frame — кадр, thumb — уменьшенная копия
// файла больше предела, thumb-huge — больше 20 МБ, thumb-format — копия файла, который не открылся как картинка); путь —
// в events.media_ref (схема v8). Повторный запрос берёт файл отсюда, без Telegram, с той же пометкой (вид в имени).
// Формат и размеры — по первым байтам файла, а не по mime Telegram. Два запроса одного № сразу — одно скачивание.
//
// Кто может смотреть — проверяет переходник (adapter.ts): проверенная аренда и сообщение, которое уже отдавалось агенту
// (этой или прежней сессии, ⟨предл.⟩ после проверки). Сюда приходит уже проверенный №. Содержимое старше срока
// хранения (свой звук — owner_voice_days, прочее — untrusted_days; retention.ts) — «содержимое удалено по сроку
// хранения», даже если суточная чистка ещё не прошла: Telegram заново не спрашивается. Скачать не вышло (сеть, Telegram,
// срок) — error unavailable «повтори позже»; диск полон — картинка всё равно уходит агенту, только не сохраняется.
// Остановка шлюза прерывает скачивания и дожидается ответов на них («шлюз останавливается — повтори позже»). Метки
// доверия не меняются: картинка — материал, «чужое» (в изображении может быть текст-указание; канал говорит это агенту
// словами).

import fs from 'node:fs';
import path from 'node:path';
import {
  BOT_API_FILE_LIMIT,
  MEDIA_VIEW_MAX_BYTES,
  TelegramApiError,
  clockDeadline,
  ensureDir,
  formatBytes,
  imageExt,
  imageInfo,
  localDate,
  sql,
  transaction,
  viewableOf,
  writeFileAtomicSync,
  type Attachment,
  type FileRef,
  type ImageInfo,
  type MediaResult,
  type Viewable,
  type WriteIo,
} from 'stg-core';
import type { Ctx } from './context.js';

/** Срок на getFile и скачивание вместе, по часам шлюза ⟨предл.⟩. Канал ждёт ответа на media 90 с. */
export const MEDIA_FILE_TIMEOUT_MS = 60_000;

const DAY_MS = 24 * 3600_000;

/** Что показано: сам файл · кадр-обложка кружка или видео · уменьшенная копия Telegram. */
export type MediaShown = 'original' | 'frame' | 'telegram_thumbnail';

/**
 * Почему показана уменьшенная копия: файл больше предела просмотра (big), больше 20 МБ — бот его не скачает (huge), или
 * не открылся как картинка (format). Пишется в имя файла в raw/ — повтор из raw/ говорит то же, что первый ответ.
 */
type ThumbWhy = 'big' | 'huge' | 'format';

/** Вид в имени файла: media · frame · thumb (больше предела) · thumb-huge (больше 20 МБ) · thumb-format (не картинка). */
function suffixOf(shown: MediaShown, why: ThumbWhy | null): string {
  if (shown === 'original') return 'media';
  if (shown === 'frame') return 'frame';
  return why === 'format' ? 'thumb-format' : why === 'huge' ? 'thumb-huge' : 'thumb';
}

/** Чем писать файл в raw/ (под тестом — «диск полон», testhooks.ts). */
export interface MediaHooks {
  fileIo(): WriteIo | undefined;
}

export type MediaOutcome = { ok: true; result: MediaResult } | { ok: false; code: 'bad_request' | 'unavailable'; text: string };

interface MediaRow {
  seq: number;
  update_id: number | null;
  kind: string;
  attachments_json: string | null;
  media_ref: string | null;
  created_at: number;
}

/** Файл больше предела Bot API: getFile отвечает «file is too big». */
class TooBigForBot extends Error {}

function attachmentsOf(json: string | null): Attachment[] {
  try {
    const v: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? (v as Attachment[]) : [];
  } catch {
    return [];
  }
}

/** Содержимое снято по сроку хранения (retention.ts): вложения стёрты или ссылки в них пусты. */
function contentRemoved(row: MediaRow, attachments: Attachment[]): boolean {
  if (row.attachments_json === null) return row.kind === 'photo' || row.kind === 'document';
  return attachments.some((a) => (a.kind === 'photo' || a.kind === 'document') && Object.keys(a.ref ?? {}).length === 0);
}

/** Вложение, которое показывается (фото или файл). */
function shownAttachment(attachments: Attachment[]): Attachment | undefined {
  return attachments.find((a) => a.kind === 'photo' || a.kind === 'document');
}

export class MediaService {
  private readonly inflight = new Map<number, Promise<MediaOutcome>>();
  private readonly stopCtl = new AbortController();

  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: MediaHooks | null = null,
  ) {}

  /**
   * Остановка шлюза: скачивания прерываются; ждём, пока на каждое начатое уйдёт ответ («шлюз останавливается — повтори
   * позже»): ответ отдаёт тот, кто ждал view(), раньше, чем закроется сокет.
   */
  async stop(): Promise<void> {
    this.stopCtl.abort();
    await Promise.allSettled([...this.inflight.values()]);
  }

  /** Картинка события № seq (проверки аренды — у вызывающего). */
  view(seq: number): Promise<MediaOutcome> {
    const cur = this.inflight.get(seq);
    if (cur) return cur;
    const p = this.run(seq).finally(() => this.inflight.delete(seq));
    this.inflight.set(seq, p);
    return p;
  }

  private async run(seq: number): Promise<MediaOutcome> {
    const row = sql(this.ctx.db, 'SELECT seq, update_id, kind, attachments_json, media_ref, created_at FROM events WHERE seq = ?').get(seq) as MediaRow | undefined;
    if (!row) return { ok: false, code: 'bad_request', text: `нет события № ${seq}` };
    const attachments = attachmentsOf(row.attachments_json);
    const v = viewableOf(attachments);
    if (!v) {
      if (contentRemoved(row, attachments)) {
        // Вложение стёрто чисткой — какой это был файл, уже не узнать: фото — «фото», прочее — «файл».
        this.ctx.journal.write('media', { seq, shown: null, reason: 'removed' });
        return this.result(seq, row.kind === 'photo' ? 'photo' : 'file', null, 'содержимое удалено по сроку хранения');
      }
      return { ok: false, code: 'bad_request', text: `в № ${seq} нет картинки: смотреть можно фото, изображение файлом, кадр кружка или видео` };
    }
    // Старше срока хранения — удалено, даже если суточная чистка ещё не прошла или оставила file_id во вложениях
    // (свой кружок, своё пересланное фото): Telegram заново не спрашивается (находка проверки).
    if (this.expired(row, attachments)) {
      this.ctx.journal.write('media', { seq, what: v.what, shown: null, reason: 'expired' });
      return this.result(seq, v.what, null, 'содержимое удалено по сроку хранения');
    }
    // Уже скачано — из raw/; пометка — по виду в имени файла (кадр, копия большого, копия неоткрывшегося).
    if (row.media_ref) {
      const cached = this.readCached(row);
      if (cached) {
        const { shown, why } = shownOfRef(row.media_ref);
        this.ctx.journal.write('media', { seq, what: v.what, shown, from: 'raw', bytes: cached.data.length, width: cached.info.width, height: cached.info.height });
        return this.result(seq, v.what, { ...cached, shown }, noteFor(v, shown, why));
      }
    }
    return this.fetch(row, v);
  }

  /**
   * Срок хранения содержимого вышел (retention.ts): свой звук файлом (кружок — вложение с меткой owner) — по сроку звука
   * владельца, всё прочее (фото, файл, видео, пересланное) — по сроку чужого.
   */
  private expired(row: MediaRow, attachments: Attachment[]): boolean {
    const r = this.ctx.config.retention;
    const days = shownAttachment(attachments)?.trust === 'owner' ? r.owner_voice_days : r.untrusted_days;
    return row.created_at < this.ctx.clock.now() - days * DAY_MS;
  }

  private readCached(row: MediaRow): { data: Buffer; info: ImageInfo } | null {
    try {
      const data = fs.readFileSync(path.join(this.ctx.paths.home, row.media_ref!));
      const info = imageInfo(data);
      if (info) return { data, info };
      this.ctx.journal.write('media_cache_bad', { seq: row.seq, media_ref: row.media_ref });
    } catch (err) {
      this.ctx.journal.write('media_cache_missing', { seq: row.seq, media_ref: row.media_ref, error: (err as Error).message });
    }
    return null;
  }

  /** Скачать нужное и показать: по виду события — файл, кадр или уменьшенную копию. */
  private async fetch(row: MediaRow, v: Viewable): Promise<MediaOutcome> {
    const seq = row.seq;
    try {
      if (v.what === 'photo') {
        const size = v.pick.size;
        if (size !== null && size > MEDIA_VIEW_MAX_BYTES) return await this.tooBig(row, v, size, null);
        return await this.downloadAndShow(row, v, v.pick, 'original');
      }
      if (v.what !== 'image') {
        // Кружок и видео — кадр-обложка Telegram.
        if (!v.thumb) {
          this.ctx.journal.write('media', { seq, what: v.what, shown: null, reason: 'no_frame' });
          return this.result(seq, v.what, null, 'кадра нет: Telegram не прислал обложку');
        }
        return await this.downloadAndShow(row, v, v.thumb, 'frame');
      }
      // Изображение файлом.
      const size = v.file.size;
      if (size !== null && size > MEDIA_VIEW_MAX_BYTES) return await this.tooBig(row, v, size, v.thumb);
      let data: Buffer;
      try {
        data = await this.download(v.file.fileId);
      } catch (err) {
        if (err instanceof TooBigForBot) return await this.tooBig(row, v, BOT_API_FILE_LIMIT + 1, v.thumb);
        throw err;
      }
      if (data.length > MEDIA_VIEW_MAX_BYTES) return await this.tooBig(row, v, data.length, v.thumb);
      const info = imageInfo(data);
      if (!info) {
        // mime у Telegram — картинка, а по первым байтам нет (HEIC под видом jpeg и т. п.): копия Telegram, если есть.
        this.ctx.journal.write('media_not_image', { seq, mime: v.file.mime, bytes: data.length });
        if (v.thumb) return await this.downloadAndShow(row, v, v.thumb, 'telegram_thumbnail', thumbNote('format', null));
        return this.result(seq, v.what, null, 'файл не открылся как картинка: формат не распознан');
      }
      return this.show(row, v, data, info, 'original', null);
    } catch (err) {
      if (this.stopCtl.signal.aborted) return { ok: false, code: 'unavailable', text: 'шлюз останавливается — повтори позже' };
      const text = this.ctx.api?.redact((err as Error).message) ?? (err as Error).message;
      this.ctx.journal.write('media_failed', { seq, what: v.what, error: text });
      return { ok: false, code: 'unavailable', text: `картинка не скачалась (${text}) — повтори позже` };
    }
  }

  /** Файл больше предела (или больше 20 МБ — бот не скачает): уменьшенная копия Telegram, если есть, иначе только текст. */
  private async tooBig(row: MediaRow, v: Viewable, bytes: number, thumb: FileRef | null): Promise<MediaOutcome> {
    const forBot = bytes > BOT_API_FILE_LIMIT;
    this.ctx.journal.write('media_too_big', { seq: row.seq, what: v.what, bytes: forBot ? null : bytes, thumbnail: !!thumb });
    if (!thumb) return this.result(row.seq, v.what, null, bigHead(bytes));
    const why: ThumbWhy = forBot ? 'huge' : 'big';
    return this.downloadAndShow(row, v, thumb, 'telegram_thumbnail', thumbNote(why, bytes), why);
  }

  private async downloadAndShow(row: MediaRow, v: Viewable, ref: FileRef, shown: MediaShown, note: string | null = null, why: ThumbWhy | null = null): Promise<MediaOutcome> {
    let data: Buffer;
    try {
      data = await this.download(ref.fileId);
    } catch (err) {
      if (err instanceof TooBigForBot) return this.result(row.seq, v.what, null, 'слишком большое для просмотра: больше 20 МБ');
      throw err;
    }
    const info = imageInfo(data);
    if (!info || data.length > MEDIA_VIEW_MAX_BYTES) {
      this.ctx.journal.write('media_not_image', { seq: row.seq, shown, bytes: data.length });
      return this.result(row.seq, v.what, null, info ? `слишком большое для просмотра: ${formatBytes(data.length)}` : 'файл не открылся как картинка: формат не распознан');
    }
    return this.show(row, v, data, info, shown, note, why ?? (shown === 'telegram_thumbnail' ? 'format' : null));
  }

  /** Сохранить в raw/ (не вышло — не беда: картинка всё равно уходит агенту) и ответить. */
  private show(row: MediaRow, v: Viewable, data: Buffer, info: ImageInfo, shown: MediaShown, note: string | null, why: ThumbWhy | null = null): MediaOutcome {
    const name = `${row.update_id ?? `s${row.seq}`}.${suffixOf(shown, why)}.${imageExt(info)}`;
    const ref = path.posix.join('raw', localDate(row.created_at, this.ctx.config.timezone), name);
    let saved = false;
    try {
      const full = path.join(this.ctx.paths.home, ref);
      ensureDir(path.dirname(full));
      writeFileAtomicSync(full, data, 0o600, this.hooks?.fileIo());
      transaction(this.ctx.db, () => sql(this.ctx.db, 'UPDATE events SET media_ref = ? WHERE seq = ?').run(ref, row.seq));
      saved = true;
    } catch (err) {
      if (!this.ctx.disk.check(err, 'media', { seq: row.seq })) this.ctx.journal.write('media_save_failed', { seq: row.seq, error: (err as Error).message });
    }
    this.ctx.journal.write('media', {
      seq: row.seq,
      what: v.what,
      shown,
      from: 'telegram',
      bytes: data.length,
      width: info.width,
      height: info.height,
      ...(saved ? { media_ref: ref } : { saved: false }),
    });
    return this.result(row.seq, v.what, { data, info, shown }, note ?? noteFor(v, shown, why));
  }

  private result(seq: number, what: string, img: { data: Buffer; info: ImageInfo; shown: MediaShown } | null, note: string | null): MediaOutcome {
    return {
      ok: true,
      result: {
        seq,
        what,
        image: img
          ? { mime: img.info.mime, data: img.data.toString('base64'), width: img.info.width, height: img.info.height, bytes: img.data.length, shown: img.shown }
          : null,
        note,
      },
    };
  }

  /**
   * getFile и скачивание — общий срок 60 с по часам шлюза (под тестом — поддельным); «file is too big» — TooBigForBot.
   * Адрес с токеном — не в журнал.
   */
  private async download(fileId: string): Promise<Buffer> {
    const api = this.ctx.api;
    if (!api) throw new Error('нет клиента Telegram (токена ещё нет)');
    const dl = clockDeadline(this.ctx.clock, MEDIA_FILE_TIMEOUT_MS, { signal: this.stopCtl.signal });
    try {
      let f: { file_path?: string };
      try {
        f = await api.call<{ file_path?: string }>('getFile', { file_id: fileId }, { signal: dl.signal });
      } catch (err) {
        if (err instanceof TelegramApiError && err.errorCode === 400 && /file is too big/i.test(err.description)) throw new TooBigForBot(err.description);
        throw err;
      }
      if (!f.file_path) throw new Error('getFile: нет file_path');
      return await api.download(f.file_path, { signal: dl.signal });
    } catch (err) {
      if (dl.expired()) throw new Error(`не уложилось в ${MEDIA_FILE_TIMEOUT_MS / 1000} с`);
      throw err;
    } finally {
      dl.cancel();
    }
  }
}

/** Что показано и почему — по имени сохранённого файла (…media… · …frame… · …thumb… · …thumb-huge… · …thumb-format…). */
function shownOfRef(ref: string): { shown: MediaShown; why: ThumbWhy | null } {
  const m = /\.(media|frame|thumb|thumb-huge|thumb-format)\.[a-z]+$/.exec(ref);
  if (m?.[1] === 'frame') return { shown: 'frame', why: null };
  if (m?.[1] === 'thumb') return { shown: 'telegram_thumbnail', why: 'big' };
  if (m?.[1] === 'thumb-huge') return { shown: 'telegram_thumbnail', why: 'huge' };
  if (m?.[1] === 'thumb-format') return { shown: 'telegram_thumbnail', why: 'format' };
  return { shown: 'original', why: null };
}

/** «слишком большое для просмотра: 7,2 МБ» (размер неизвестен — без него; больше 20 МБ — «больше 20 МБ»). */
function bigHead(bytes: number | null): string {
  if (bytes === null) return 'слишком большое для просмотра';
  return `слишком большое для просмотра: ${bytes > BOT_API_FILE_LIMIT ? 'больше 20 МБ' : formatBytes(bytes)}`;
}

/** Пометка к уменьшенной копии Telegram — одна и та же в первом ответе и в повторе из raw/. */
function thumbNote(why: ThumbWhy, bytes: number | null): string {
  if (why === 'format') return 'файл не открылся как картинка (формат не распознан) — показываю уменьшенную копию Telegram';
  const head = why === 'huge' ? bigHead(BOT_API_FILE_LIMIT + 1) : bigHead(bytes);
  return `${head} — показываю уменьшенную копию Telegram: мелкое не разглядеть; можно попросить прислать фото, а не файлом`;
}

/**
 * Пометка агенту: у кадра — что это один кадр; у уменьшенной копии — почему она (при повторе из raw/ размер — из
 * метаданных Telegram).
 */
function noteFor(v: Viewable, shown: MediaShown, why: ThumbWhy | null): string | null {
  if (shown === 'frame') return `кадр-обложка Telegram: один кадр ${v.what === 'video_note' ? 'кружка' : 'видео'}, а не всё видео`;
  if (shown === 'telegram_thumbnail') return thumbNote(why ?? 'big', v.what === 'image' ? v.file.size : null);
  return null;
}

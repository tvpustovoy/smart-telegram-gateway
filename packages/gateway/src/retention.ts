// Хранение и чистка (TECH-SPEC 5.8; ACCEPTANCE A4.5) — раз в сутки, сроки из config.yaml (retention):
// - звук владельца (голосовые с метками owner и owner_forward; с 0.3 — и свой аудиофайл и свой кружок без пересылки:
//   вложение с меткой owner; хранение как у голоса — ⟨предл.⟩, метка кружка — развилка R-20) старше owner_voice_days —
//   файл (у кружка — и кадр); расшифровка и текст остаются;
// - прочий звук файлом и картинки (событие document с файлом в raw/ или расшифровкой; media_ref — картинка для агента,
//   0.3) — по правилам для файлов: содержимое «чужое» даже от владельца (Ш-20) — старше untrusted_days файл и расшифровка
//   удаляются, как у чужого, а подпись владельца остаётся;
// - чужое (untrusted) старше untrusted_days — файл и events.text, transcript, attachments_json, а с ними forward_json
//   (имя чужого автора) и тексты строк шлюза об этом событии (квитанция с началом чужого текста, полная расшифровка);
//   остаются №, дата, метка. У смешанного сообщения (слова владельца + чужое) — ссылки на чужое во вложениях;
// - журнал logs/ старше logs_days — файлы целиком; строки о чужом старше untrusted_days в оставшихся файлах — без текста;
// - raw/closed/ — через closed_days ⟨предл.: 30⟩, каталогами по дате;
// - брошенные файлы звука (обновление не стало событием) — после самого долгого срока звука;
// - копии посылок raw/parcels/<sha256> (0.3.3, 5.16) — по правилам для файлов: последняя доставка с копией старше
//   untrusted_days и ни одна не ждёт отправки — копия удалена, ссылка снята (copy_ref NULL); строки доставок остаются
//   ⟨предл.: посылка, файл, версия, куда, когда — без содержимого⟩. Копия без ссылки (упали между снимком и записью,
//   временный файл) — через сутки.
// Удалённое из базы не должно оставаться в её свободных страницах: чистка чужого идёт с secure_delete, затем VACUUM и
// сброс WAL. Файл удаляется раньше, чем ссылка на него в базе: упали посередине — ссылка на пустое место, при следующей
// чистке удаление повторится безвредно.

import fs from 'node:fs';
import path from 'node:path';
import { META_KEYS, PARCEL_STORE_DIR, getMeta, localDate, setMeta, sql, transaction, writeFileAtomicSync, type Attachment } from 'stg-core';
import type { Ctx } from './context.js';

export const RETENTION_EVERY_MS = 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOG_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
/**
 * Свой звук файлом (0.3): вложение document с меткой owner — свой аудиофайл (развилка R-2) или свой кружок (развилка
 * R-20) без пересылки (trust.ts). Хранится как голосовое владельца ⟨предл.⟩.
 */
const OWN_SOUND_SQL = "EXISTS (SELECT 1 FROM json_each(events.attachments_json) AS a WHERE json_extract(a.value, '$.kind') = 'document' AND json_extract(a.value, '$.trust') = 'owner')";
/** Поля строки журнала, где бывает содержимое сообщения. */
const CONTENT_FIELDS = ['text', 'transcript', 'attachments', 'forward'] as const;

export interface RetentionReport {
  ownerVoiceFiles: number;
  untrustedEvents: number;
  mixedEvents: number;
  closedDirs: number;
  orphanFiles: number;
  logFilesDeleted: number;
  logFilesScrubbed: number;
  /** Копий посылок удалено (0.3.3): по сроку и без ссылки. */
  parcelCopies: number;
}

export class Retention {
  constructor(private readonly ctx: Ctx) {}

  /** Раз в сутки (по часам шлюза): прошло 24 ч с прошлой чистки или её ещё не было. */
  maybeRun(now: number): RetentionReport | null {
    const last = Number(getMeta(this.ctx.db, META_KEYS.retentionAt) ?? 'NaN');
    if (Number.isFinite(last) && now - last < RETENTION_EVERY_MS && now >= last) return null;
    return this.run(now);
  }

  run(now: number): RetentionReport {
    const { config } = this.ctx;
    const r = config.retention;
    const report: RetentionReport = {
      ownerVoiceFiles: this.ownerVoice(now - r.owner_voice_days * DAY_MS),
      untrustedEvents: 0,
      mixedEvents: 0,
      closedDirs: this.closed(now - r.closed_days * DAY_MS),
      orphanFiles: this.orphans(now - Math.max(r.owner_voice_days, r.untrusted_days) * DAY_MS),
      logFilesDeleted: 0,
      logFilesScrubbed: 0,
      parcelCopies: this.parcelCopies(now - r.untrusted_days * DAY_MS, now - DAY_MS),
    };
    const cutoffU = now - r.untrusted_days * DAY_MS;
    // Звук файлом с содержимым — до чистки (после неё его уже не узнать): чьи строки журнала тоже без содержимого. Свой
    // звук (аудиофайл, кружок — слово владельца) — нет.
    const audio = new Set(
      (sql(this.ctx.db, `SELECT seq FROM events WHERE kind = 'document' AND (transcript IS NOT NULL OR raw_ref IS NOT NULL) AND NOT ${OWN_SOUND_SQL} AND created_at < ?`).all(cutoffU) as Array<{
        seq: number;
      }>).map((x) => x.seq),
    );
    const foreign = this.untrusted(cutoffU);
    report.untrustedEvents = foreign.events;
    report.mixedEvents = foreign.mixed;
    report.logFilesDeleted = this.deleteLogs(now - r.logs_days * DAY_MS);
    report.logFilesScrubbed = this.scrubLogs(cutoffU, audio);
    if (foreign.events || foreign.mixed) this.compact();
    transaction(this.ctx.db, () => setMeta(this.ctx.db, META_KEYS.retentionAt, String(now)));
    this.ctx.journal.write('retention', { ...report });
    return report;
  }

  private rm(rel: string): void {
    fs.rmSync(path.join(this.ctx.paths.home, rel), { force: true });
  }

  /**
   * Звук владельца старше срока: файл удалён, ссылка снята; расшифровка остаётся. Голосовое — и свой звук файлом
   * (аудиофайл, кружок с его кадром; 0.3).
   */
  private ownerVoice(cutoff: number): number {
    const rows = sql(this.ctx.db,
      `SELECT seq, raw_ref, media_ref FROM events WHERE (raw_ref IS NOT NULL OR media_ref IS NOT NULL)
       AND ((kind = 'voice' AND trust IN ('owner', 'owner_forward')) OR (kind = 'document' AND ${OWN_SOUND_SQL}))
       AND created_at < ?`,
    ).all(cutoff) as Array<{ seq: number; raw_ref: string | null; media_ref: string | null }>;
    for (const row of rows) {
      if (row.raw_ref) this.rm(row.raw_ref);
      if (row.media_ref) this.rm(row.media_ref);
    }
    if (rows.length) {
      transaction(this.ctx.db, () => {
        for (const row of rows) sql(this.ctx.db, 'UPDATE events SET raw_ref = NULL, media_ref = NULL WHERE seq = ?').run(row.seq);
      });
    }
    return rows.length;
  }

  /**
   * Чужое старше срока: файл, текст, расшифровка, вложения, пересылка; строки шлюза о нём — без текста. Смешанное —
   * ссылки на чужое во вложениях.
   */
  private untrusted(cutoff: number): { events: number; mixed: number } {
    const { db } = this.ctx;
    const rows = sql(db,
      `SELECT seq, raw_ref, media_ref FROM events WHERE trust = 'untrusted' AND created_at < ?
       AND (text IS NOT NULL OR transcript IS NOT NULL OR attachments_json IS NOT NULL OR raw_ref IS NOT NULL OR forward_json IS NOT NULL
            OR media_ref IS NOT NULL)`,
    ).all(cutoff) as Array<{ seq: number; raw_ref: string | null; media_ref: string | null }>;
    for (const row of rows) {
      if (row.raw_ref) this.rm(row.raw_ref);
      if (row.media_ref) this.rm(row.media_ref);
    }
    const mixed = (sql(db, "SELECT seq, attachments_json FROM events WHERE trust <> 'untrusted' AND mixed = 1 AND attachments_json IS NOT NULL AND created_at < ?")
      .all(cutoff) as Array<{ seq: number; attachments_json: string }>)
      .map((m) => {
        let list: Attachment[];
        try {
          list = JSON.parse(m.attachments_json) as Attachment[];
        } catch {
          return { seq: m.seq, json: null as string | null, changed: true };
        }
        let changed = false;
        const out = list.map((a) => {
          if (a.trust === 'owner' || Object.keys(a.ref ?? {}).length === 0) return a;
          changed = true;
          return { ...a, ref: {} };
        });
        return { seq: m.seq, json: JSON.stringify(out), changed };
      })
      .filter((m) => m.changed);
    // Файл у сообщения владельца (подпись — его слово, файл — чужое): звук, расшифровка и картинка для агента (media_ref,
    // 0.3: фото, изображение файлом, кадр видео) — как у чужого; строки шлюза о нём (ответ-расшифровка; у прежних версий —
    // квитанция с первыми словами и полная расшифровка) — без текста. Подпись остаётся. Свой звук (аудиофайл, кружок — слово владельца) — не здесь:
    // его файл уходит по сроку звука владельца, расшифровка остаётся (ownerVoice).
    const audio = sql(db,
      `SELECT seq, raw_ref, media_ref FROM events WHERE trust <> 'untrusted' AND created_at < ?
       AND ((kind = 'document' AND (transcript IS NOT NULL OR raw_ref IS NOT NULL)) OR media_ref IS NOT NULL)
       AND NOT ${OWN_SOUND_SQL}`,
    ).all(cutoff) as Array<{ seq: number; raw_ref: string | null; media_ref: string | null }>;
    for (const a of audio) {
      if (a.raw_ref) this.rm(a.raw_ref);
      if (a.media_ref) this.rm(a.media_ref);
    }
    if (!rows.length && !mixed.length && !audio.length) return { events: 0, mixed: 0 };
    db.exec('PRAGMA secure_delete = ON');
    try {
      transaction(db, () => {
        for (const row of rows) {
          sql(db, 'UPDATE events SET text = NULL, transcript = NULL, attachments_json = NULL, raw_ref = NULL, media_ref = NULL, forward_json = NULL WHERE seq = ?').run(row.seq);
          sql(db, "UPDATE outbox SET text = NULL WHERE event_seq = ? AND origin = 'gateway'").run(row.seq);
          sql(db, "UPDATE edits SET text = NULL WHERE event_seq = ? AND status <> 'pending'").run(row.seq);
        }
        for (const m of mixed) sql(db, 'UPDATE events SET attachments_json = ? WHERE seq = ?').run(m.json, m.seq);
        for (const a of audio) {
          sql(db, 'UPDATE events SET transcript = NULL, raw_ref = NULL, media_ref = NULL WHERE seq = ?').run(a.seq);
          sql(db, "UPDATE outbox SET text = NULL WHERE event_seq = ? AND origin = 'gateway'").run(a.seq);
          sql(db, "UPDATE edits SET text = NULL WHERE event_seq = ? AND status <> 'pending'").run(a.seq);
        }
      });
    } finally {
      db.exec('PRAGMA secure_delete = OFF');
    }
    const mixedSeqs = new Set([...mixed.map((m) => m.seq), ...audio.map((a) => a.seq)]);
    return { events: rows.length, mixed: mixedSeqs.size };
  }

  /** После чистки чужого — пересобрать базу и сбросить WAL: удалённый текст не остаётся в свободных страницах. */
  private compact(): void {
    try {
      this.ctx.db.exec('VACUUM');
      this.ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      // Занято читателем (stg) или диск полон — пересоберётся при следующей чистке.
      this.ctx.journal.write('retention_compact_failed', { error: (err as Error).message });
    }
  }

  /** raw/closed/<дата>/ старше срока — целиком; ссылки закрытой темы на них — сняты. */
  private closed(cutoff: number): number {
    const limit = localDate(cutoff, this.ctx.config.timezone);
    let dirs = 0;
    for (const name of this.dateDirs(this.ctx.paths.rawClosed)) {
      if (name >= limit) continue;
      fs.rmSync(path.join(this.ctx.paths.rawClosed, name), { recursive: true, force: true });
      dirs++;
    }
    transaction(this.ctx.db, () =>
      sql(this.ctx.db, "UPDATE events SET raw_ref = NULL WHERE kind = 'closed_topic' AND raw_ref IS NOT NULL AND created_at < ?").run(cutoff),
    );
    return dirs;
  }

  /** Файлы в raw/<дата>/, на которые не ссылается ни одно событие (звук или картинка), — после срока; пустые каталоги — сразу. */
  private orphans(cutoff: number): number {
    const limit = localDate(cutoff, this.ctx.config.timezone);
    const raw = this.ctx.paths.raw;
    let n = 0;
    for (const name of this.dateDirs(raw)) {
      const dir = path.join(raw, name);
      if (name < limit) {
        for (const f of fs.readdirSync(dir)) {
          const rel = path.posix.join('raw', name, f);
          if (sql(this.ctx.db, 'SELECT 1 FROM events WHERE raw_ref = ? OR media_ref = ? LIMIT 1').get(rel, rel)) continue;
          fs.rmSync(path.join(dir, f), { force: true, recursive: true });
          n++;
        }
      }
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // каталог занят или уже убран
      }
    }
    return n;
  }

  /**
   * Копии посылок (0.3.3): по сроку — у которых последняя доставка старше cutoff и ни одна не ждёт отправки; без ссылки
   * (и временные) — старше orphanCutoff. Файл — раньше ссылки: упали посередине — ссылка на пустое место, отправитель
   * такую доставку бросит (копии нет), следующая чистка снимет ссылку.
   */
  private parcelCopies(cutoff: number, orphanCutoff: number): number {
    const dir = path.join(this.ctx.paths.raw, PARCEL_STORE_DIR);
    let n = 0;
    const old = sql(this.ctx.db,
      `SELECT copy_ref FROM deliveries WHERE copy_ref IS NOT NULL GROUP BY copy_ref
       HAVING MAX(created_at) < ? AND SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) = 0`,
    ).all(cutoff) as Array<{ copy_ref: string }>;
    for (const { copy_ref } of old) {
      this.rm(copy_ref);
      transaction(this.ctx.db, () => sql(this.ctx.db, 'UPDATE deliveries SET copy_ref = NULL WHERE copy_ref = ?').run(copy_ref));
      n++;
    }
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return n;
    }
    for (const f of names) {
      const full = path.join(dir, f);
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (!st || st.mtimeMs >= orphanCutoff) continue;
      const rel = path.posix.join('raw', PARCEL_STORE_DIR, f);
      if (sql(this.ctx.db, 'SELECT 1 FROM deliveries WHERE copy_ref = ? LIMIT 1').get(rel)) continue;
      fs.rmSync(full, { force: true, recursive: true });
      n++;
    }
    return n;
  }

  private dateDirs(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && DATE_DIR_RE.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  private logFiles(): Array<{ name: string; date: string }> {
    try {
      return fs
        .readdirSync(this.ctx.paths.logs)
        .map((name) => ({ name, m: LOG_FILE_RE.exec(name) }))
        .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
        .map((x) => ({ name: x.name, date: x.m[1]! }));
    } catch {
      return [];
    }
  }

  /** Файлы журнала старше logs_days — целиком (launchd.log не трогается). */
  private deleteLogs(cutoff: number): number {
    const limit = localDate(cutoff, this.ctx.config.timezone);
    let n = 0;
    for (const f of this.logFiles()) {
      if (f.date >= limit) continue;
      fs.rmSync(path.join(this.ctx.paths.logs, f.name), { force: true });
      n++;
    }
    return n;
  }

  /**
   * Строки журнала о чужом старше срока — без содержимого (text, transcript, вложения, пересылка): строки с меткой
   * untrusted и строки шлюза о таких событиях (квитанция, расшифровка, правка квитанции). Слова агента остаются.
   * Смотрятся только файлы, где такие строки могут быть (дата файла не позже срока).
   */
  private scrubLogs(cutoff: number, audio: ReadonlySet<number> = new Set()): number {
    const limit = localDate(cutoff, this.ctx.config.timezone);
    const files = this.logFiles().filter((f) => f.date <= limit);
    if (!files.length) return 0;
    const foreign = new Set(
      (sql(this.ctx.db, "SELECT seq FROM events WHERE trust = 'untrusted' AND created_at < ?").all(cutoff) as Array<{ seq: number }>).map((r) => r.seq),
    );
    let scrubbed = 0;
    for (const f of files) {
      const file = path.join(this.ctx.paths.logs, f.name);
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      let changed = false;
      const lines = text.split('\n').map((line) => {
        if (!line.trim()) return line;
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return line;
        }
        if (typeof rec.at !== 'string' || Date.parse(rec.at) >= cutoff) return line;
        if (!CONTENT_FIELDS.some((k) => k in rec)) return line;
        const seqs = [rec.seq, rec.event_seq, ...(Array.isArray(rec.event_seqs) ? rec.event_seqs : [])].filter((x): x is number => typeof x === 'number');
        // Файл у сообщения владельца: без содержимого — расшифровка (метка untrusted) и строки шлюза о нём; его подпись
        // (метка owner) остаётся. Свой звук (аудиофайл, кружок) — не здесь: его расшифровка с меткой owner.
        const aboutForeign =
          rec.label === 'untrusted' ||
          (rec.label !== 'agent' && seqs.some((s) => foreign.has(s))) ||
          (rec.label !== 'agent' && rec.label !== 'owner' && seqs.some((s) => audio.has(s)));
        if (!aboutForeign) return line;
        for (const k of CONTENT_FIELDS) delete rec[k];
        rec.scrubbed = true;
        changed = true;
        return JSON.stringify(rec);
      });
      if (!changed) continue;
      writeFileAtomicSync(file, lines.join('\n'), 0o600);
      scrubbed++;
    }
    return scrubbed;
  }
}

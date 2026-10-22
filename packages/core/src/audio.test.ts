// Аудиофайлы (J-2, 5.8): что считается аудио, расширение из имени файла, что уходит провайдеру. С 0.3 — свой аудиофайл
// без пересылки — слово владельца (R-2); кружок и видео в mp4 — звук для распознавания.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '@grammyjs/types';
import { BOT_API_FILE_LIMIT, audioFileOf, isNotMp4Video, providerAudioFile } from './audio.js';
import { parseConfig, roleDisplayName } from './config.js';
import { labelMessage } from './trust.js';

const owner = { id: 111, is_bot: false, first_name: 'Анна' };
const base = { message_id: 1, date: 1, chat: { id: 111, type: 'private', first_name: 'Анна' }, from: owner };

function label(extra: Record<string, unknown>) {
  return labelMessage({ ...base, ...extra } as unknown as Message, { ownerId: 111, fromOwner: true });
}

describe('аудиофайл: что это и как его отдать провайдеру', () => {
  it('message.audio — аудио; длительность и размер из метаданных; свой без пересылки — слово владельца (R-2), подпись — тоже', () => {
    const l = label({ audio: { file_id: 'a1', file_unique_id: 'ua1', duration: 754, file_name: 'Встреча.m4a', mime_type: 'audio/mpeg', file_size: 9_000_000 }, caption: 'запиши итоги' });
    assert.equal(l.kind, 'document');
    assert.deepEqual({ trust: l.trust, mixed: l.mixed }, { trust: 'owner', mixed: false });
    const a = audioFileOf(l.attachments);
    assert.deepEqual(a, { source: 'audio', trust: 'owner', fileId: 'a1', fileName: 'Встреча.m4a', label: 'Встреча.m4a', mime: 'audio/mpeg', duration: 754, size: 9_000_000, ext: 'm4a' });
    // Telegram отдал для .m4a audio/mpeg — расширение и mime для провайдера берутся из имени файла.
    assert.deepEqual(providerAudioFile(a!, '42'), { filename: 'Встреча.m4a', mime: 'audio/mp4' });
  });

  it('document с mime audio/* или расширением аудио — аудио; без длительности; .oga и .opus уходят как .ogg', () => {
    const ogg = audioFileOf(label({ document: { file_id: 'd1', file_unique_id: 'u', file_name: 'note.opus', mime_type: 'application/octet-stream', file_size: 1000 } }).attachments);
    assert.equal(ogg?.duration, null);
    assert.equal(ogg?.ext, 'opus');
    assert.deepEqual(providerAudioFile(ogg!, '7'), { filename: 'note.ogg', mime: 'audio/ogg' });
    const byMime = audioFileOf(label({ document: { file_id: 'd2', file_unique_id: 'u', mime_type: 'audio/x-wav' } }).attachments);
    assert.equal(byMime?.ext, 'wav');
    assert.equal(byMime?.label, 'без имени');
    assert.deepEqual(providerAudioFile(byMime!, '9'), { filename: '9.wav', mime: 'audio/wav' });
    for (const ext of ['mp3', 'flac', 'aac', 'webm', 'oga', 'ogg', 'wav', 'm4a']) {
      assert.ok(audioFileOf(label({ document: { file_id: 'x', file_unique_id: 'u', file_name: `f.${ext.toUpperCase()}`, mime_type: 'application/octet-stream' } }).attachments), ext);
    }
  });

  it('P-15, R-2: свой аудиофайл без пересылки — слово владельца; пересланный, через инлайн-бота, от другого — чужое; с цитатой — его слово + чужое (цитата)', () => {
    const audio = { file_id: 'a2', file_unique_id: 'ua2', duration: 30, file_name: 'мысль.m4a', mime_type: 'audio/mp4', file_size: 300_000 };
    const own = label({ audio });
    assert.deepEqual({ trust: own.trust, mixed: own.mixed, attachments: own.attachments.map((a) => `${a.kind}:${a.trust}`) }, { trust: 'owner', mixed: false, attachments: ['document:owner'] });
    // То же документом (диктофон: .m4a файлом).
    const doc = label({ document: { file_id: 'd3', file_unique_id: 'u', file_name: 'Запись.m4a', mime_type: 'audio/x-m4a', file_size: 400_000 } });
    assert.deepEqual({ trust: doc.trust, mixed: doc.mixed, att: doc.attachments[0]?.trust }, { trust: 'owner', mixed: false, att: 'owner' });
    // Пересланный от другого — чужое целиком; свой пересланный — «своё пересланное».
    const fwd = labelMessage(
      { ...base, audio, forward_origin: { type: 'user', date: 1, sender_user: { id: 222, is_bot: false, first_name: 'Аня' } } } as unknown as Message,
      { ownerId: 111, fromOwner: true },
    );
    assert.deepEqual({ trust: fwd.trust, mixed: fwd.mixed, att: fwd.attachments[0]?.trust }, { trust: 'untrusted', mixed: false, att: 'untrusted' });
    const selfFwd = labelMessage({ ...base, audio, forward_origin: { type: 'user', date: 1, sender_user: owner } } as unknown as Message, { ownerId: 111, fromOwner: true });
    assert.equal(selfFwd.attachments[0]?.trust, 'owner_forward');
    // Через инлайн-бота — чужое.
    const via = label({ audio, via_bot: { id: 5, is_bot: true, first_name: 'bot', username: 'somebot' } });
    assert.deepEqual({ trust: via.trust, att: via.attachments.find((a) => a.kind === 'document')?.trust }, { trust: 'untrusted', att: 'untrusted' });
    // От другого участника — чужое.
    const other = labelMessage({ ...base, from: { id: 333, is_bot: false, first_name: 'Гость' }, audio } as unknown as Message, { ownerId: 111, fromOwner: false });
    assert.equal(other.attachments[0]?.trust, 'untrusted');
    // С цитатой из другого чата: его слово, к нему приложено чужое — цитата, а не файл.
    const quoted = label({ audio, quote: { text: 'чужая строка', position: 0 } });
    assert.deepEqual({ trust: quoted.trust, mixed: quoted.mixed, att: quoted.attachments.map((a) => `${a.kind}:${a.trust}`) }, { trust: 'owner', mixed: true, att: ['quote:untrusted', 'document:owner'] });
    // Файл не аудио (pdf) — по-прежнему чужое.
    assert.equal(label({ document: { file_id: 'p2', file_unique_id: 'u', file_name: 'a.pdf', mime_type: 'application/pdf' } }).attachments[0]?.trust, 'untrusted');
  });

  it('P-14: кружок — звук mp4, свой — слово владельца, пересланный — чужое; видео mp4 — звук, но чужое; .mov — не распознаётся', () => {
    const vn = { file_id: 'vn1', file_unique_id: 'uvn1', length: 384, duration: 42, file_size: 900_000, thumbnail: { file_id: 'th1', file_unique_id: 'uth1', width: 320, height: 320, file_size: 9000 } };
    const own = label({ video_note: vn });
    assert.deepEqual({ kind: own.kind, trust: own.trust, mixed: own.mixed, att: own.attachments[0]?.trust }, { kind: 'document', trust: 'owner', mixed: false, att: 'owner' });
    const a = audioFileOf(own.attachments);
    assert.deepEqual(a, { source: 'video_note', trust: 'owner', fileId: 'vn1', fileName: null, label: 'кружок', mime: 'video/mp4', duration: 42, size: 900_000, ext: 'mp4' });
    // Провайдеру — mp4 как video/mp4: OpenAI и ElevenLabs принимают его.
    assert.deepEqual(providerAudioFile(a!, '77'), { filename: '77.mp4', mime: 'video/mp4' });
    // Обложка — в ref (для media), без содержимого.
    assert.deepEqual(own.attachments[0]?.ref.thumbnail, { file_id: 'th1', file_unique_id: 'uth1', width: 320, height: 320, file_size: 9000 });
    const fwd = labelMessage(
      { ...base, video_note: vn, forward_origin: { type: 'hidden_user', date: 1, sender_user_name: 'Кто-то' } } as unknown as Message,
      { ownerId: 111, fromOwner: true },
    );
    assert.deepEqual({ trust: fwd.trust, att: fwd.attachments[0]?.trust, src: audioFileOf(fwd.attachments)?.trust }, { trust: 'untrusted', att: 'untrusted', src: 'untrusted' });
    // Видео mp4: звук распознаётся, но это материал — чужое даже от владельца ⟨предл.⟩.
    const video = label({ video: { file_id: 'v1', file_unique_id: 'uv1', width: 720, height: 1280, duration: 75, mime_type: 'video/mp4', file_name: 'IMG_1.MOV', file_size: 5_000_000 }, caption: 'смотри' });
    assert.deepEqual({ trust: video.trust, mixed: video.mixed, att: video.attachments[0]?.trust }, { trust: 'owner', mixed: true, att: 'untrusted' });
    const va = audioFileOf(video.attachments);
    assert.deepEqual({ source: va?.source, label: va?.label, ext: va?.ext }, { source: 'video', label: 'IMG_1.MOV', ext: 'mp4' });
    assert.deepEqual(providerAudioFile(va!, '9'), { filename: 'IMG_1.mp4', mime: 'video/mp4' });
    const mov = label({ video: { file_id: 'v2', file_unique_id: 'u', width: 1, height: 1, duration: 3, mime_type: 'video/quicktime' } });
    assert.equal(audioFileOf(mov.attachments), null, '.mov — не распознаём');
    // Сведение 0.3 и 0.3.1: видео не в mp4 узнаётся — владельцу короткий ответ «не в mp4» ⟨предл.⟩; mp4, кружок, аудио — нет.
    assert.equal(isNotMp4Video(mov.attachments), true);
    assert.equal(isNotMp4Video(video.attachments), false);
    assert.equal(isNotMp4Video(own.attachments), false);
    assert.equal(isNotMp4Video(label({ document: { file_id: 'p', file_unique_id: 'u', file_name: 'a.pdf', mime_type: 'application/pdf' } }).attachments), false);
  });

  it('исправления по проверке сведения: видео без mime и имени — пробуем как mp4 ⟨предл.⟩; видео файлом (document video/*) — обычный файл (R-22)', () => {
    // Нет ни mime, ни имени — не «не в mp4»: распознаём как mp4 (не примет провайдер — «Не смог распознать — видео сохранено»).
    const bare = label({ video: { file_id: 'v3', file_unique_id: 'u3', width: 720, height: 1280, duration: 9, file_size: 400_000 } });
    assert.equal(isNotMp4Video(bare.attachments), false);
    const ba = audioFileOf(bare.attachments);
    assert.deepEqual({ source: ba?.source, label: ba?.label, mime: ba?.mime, ext: ba?.ext }, { source: 'video', label: 'видео', mime: 'video/mp4', ext: 'mp4' });
    assert.deepEqual(providerAudioFile(ba!, '12'), { filename: '12.mp4', mime: 'video/mp4' });
    // Без mime, но имя с расширением — по нему: .mov — не mp4, .mp4 — mp4.
    const movName = label({ video: { file_id: 'v4', file_unique_id: 'u4', width: 1, height: 1, duration: 3, file_name: 'IMG_7.MOV' } });
    assert.equal(isNotMp4Video(movName.attachments), true);
    assert.equal(audioFileOf(movName.attachments), null);
    const mp4Name = label({ video: { file_id: 'v5', file_unique_id: 'u5', width: 1, height: 1, duration: 3, file_name: 'clip.mp4' } });
    assert.equal(audioFileOf(mp4Name.attachments)?.source, 'video');
    // Видео файлом (без сжатия): Telegram присылает message.document с mime video/* — это обычный файл: не звук, не
    // «видео не в mp4», ответа владельцу нет (как в 0.3). Распознавать ли — развилка R-22, issue #43.
    for (const doc of [
      { file_id: 'd1', file_unique_id: 'ud1', file_name: 'IMG_0043.MOV', mime_type: 'video/quicktime', file_size: 9_000_000 },
      { file_id: 'd2', file_unique_id: 'ud2', file_name: 'clip.mp4', mime_type: 'video/mp4', file_size: 9_000_000 },
    ]) {
      const f = label({ document: doc });
      assert.equal(audioFileOf(f.attachments), null, doc.file_name);
      assert.equal(isNotMp4Video(f.attachments), false, doc.file_name);
      assert.equal(f.attachments[0]?.trust, 'untrusted', doc.file_name);
    }
  });

  it('не аудио: pdf, фото, голосовое (у него свой путь)', () => {
    assert.equal(audioFileOf(label({ document: { file_id: 'p', file_unique_id: 'u', file_name: 'a.pdf', mime_type: 'application/pdf' } }).attachments), null);
    assert.equal(audioFileOf(label({ photo: [{ file_id: 'ph', file_unique_id: 'u', width: 1, height: 1 }] }).attachments), null);
    assert.equal(audioFileOf(label({ voice: { file_id: 'v', file_unique_id: 'u', duration: 3 } }).attachments), null);
    assert.equal(BOT_API_FILE_LIMIT, 20 * 1024 * 1024);
  });

  it('config.yaml: stt.audio_max_minutes = 15 по умолчанию; ui.where_ttl_minutes = 5; имя роли — одно везде, своё — ui.role_short', () => {
    const c = parseConfig({ bot: 'b', owner_id: 1, timezone: 'UTC' }, { test: false });
    assert.equal(c.stt.audio_max_minutes, 15);
    assert.equal(c.ui.where_ttl_minutes, 5);
    // Короткого «ассистент» по умолчанию больше нет: полное имя с большой буквы, как в объявлениях темы.
    assert.equal(roleDisplayName(c, 'личный ассистент'), 'Личный ассистент');
    assert.equal(roleDisplayName(c, 'секретарь'), 'Секретарь');
    const c2 = parseConfig(
      { bot: 'b', owner_id: 1, timezone: 'UTC', stt: { provider: 'elevenlabs', audio_max_minutes: 10 }, ui: { where_ttl_minutes: 2, role_short: { 'личный ассистент': 'Личный' } } },
      { test: false },
    );
    assert.equal(c2.stt.audio_max_minutes, 10);
    assert.equal(c2.ui.where_ttl_minutes, 2);
    assert.equal(roleDisplayName(c2, 'личный  ассистент'), 'Личный');
    assert.throws(() => parseConfig({ bot: 'b', owner_id: 1, timezone: 'UTC', ui: { ttl: 1 } }, { test: false }), /ui/);
  });
});

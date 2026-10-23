// Инструменты агента ↔ Codex (#55): наши 8 инструментов (stg-channel, toolsFor('codex')) уходят в thread/start как
// dynamic tools; вызов приходит адаптеру запросом item/tool/call и исполняется тем же callTool, что и у канала Claude
// Code. Исход → contentItems: текст — inputText, картинка (media) — inputImage с data URL.
// Отсюда же адаптер узнаёт, на какие № есть ответ агента: reply, done, send_file с seq; episode_summary закрывает событие
// «эп. N закрыт» своего эпизода.

import { toolsFor, type ToolOutcome } from 'stg-channel';
import type { DynamicContentItem, DynamicToolSpec, ToolCallResponse } from './protocol.js';

/** Наши инструменты в форме DynamicToolFunctionSpec. */
export function dynamicTools(): DynamicToolSpec[] {
  return toolsFor('codex').map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** Исход callTool → ответ на item/tool/call. */
export function toToolResponse(out: ToolOutcome): ToolCallResponse {
  const contentItems: DynamicContentItem[] = out.content.map((c) =>
    c.type === 'text' ? { type: 'inputText', text: c.text } : { type: 'inputImage', imageUrl: `data:${c.mimeType};base64,${c.data}` },
  );
  return { contentItems, success: out.isError !== true };
}

/** Отказ без похода к шлюзу (стоп, неизвестный инструмент). */
export function refusal(text: string): ToolCallResponse {
  return { contentItems: [{ type: 'inputText', text }], success: false };
}

function int(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * На какие № этот успешный вызов — ответ агента (событие обработано). episode_summary — № эпизода (событие «эп. N
 * закрыт» ищет адаптер). Вызов с отказом шлюза — ничего.
 */
export function answeredBy(tool: string, args: Record<string, unknown>, ok: boolean): { seqs: number[]; episode: number | null } {
  if (!ok) return { seqs: [], episode: null };
  switch (tool) {
    case 'reply':
    case 'send_file': {
      const s = int(args.seq);
      return { seqs: s === null ? [] : [s], episode: null };
    }
    case 'done': {
      const raw = Array.isArray(args.seqs) ? args.seqs : [args.seqs];
      return { seqs: raw.map(int).filter((n): n is number => n !== null), episode: null };
    }
    case 'episode_summary':
      return { seqs: [], episode: int(args.episode_id) };
    default:
      return { seqs: [], episode: null };
  }
}

/** Короткая строка ленты о вызове: что и с каким исходом. Текст ответа — как есть, коротко; секретов в нём нет. */
export function describeCall(tool: string, args: Record<string, unknown>, out: ToolCallResponse): { kind: 'out' | 'tool'; text: string } {
  const first = out.contentItems.find((c) => c.type === 'inputText');
  const result = first && first.type === 'inputText' ? first.text : '';
  const image = out.contentItems.some((c) => c.type === 'inputImage') ? ' (+ картинка)' : '';
  const verdict = `${out.success ? '✓' : '✗'} ${short(result, 120)}${image}`;
  const seq = int(args.seq);
  switch (tool) {
    case 'reply': {
      const voice = args.voice === true ? ' голосом' : '';
      const from = typeof args.from === 'string' && args.from.trim() ? ` от «${short(args.from, 40)}»` : '';
      return { kind: 'out', text: `reply${seq !== null ? ` № ${seq}` : ' (по своей инициативе)'}${voice}${from}: «${short(String(args.text ?? ''), 400)}» → ${verdict}` };
    }
    case 'send_file':
      return { kind: 'out', text: `send_file${seq !== null ? ` № ${seq}` : ''}: ${short(String(args.path ?? ''), 120)} → ${verdict}` };
    case 'done': {
      const raw = Array.isArray(args.seqs) ? args.seqs : [args.seqs];
      return { kind: 'tool', text: `done № ${raw.map((v) => String(v)).join(', ')} → ${verdict}` };
    }
    case 'media':
      return { kind: 'tool', text: `media № ${String(args.seq ?? '?')} → ${verdict}` };
    case 'episode':
      return { kind: 'tool', text: `episode ${String(args.action ?? '')} «${short(String(args.topic ?? ''), 80)}» → ${verdict}` };
    case 'episode_summary':
      return { kind: 'tool', text: `episode_summary эп. ${String(args.episode_id ?? '?')} → ${verdict}` };
    default:
      return { kind: 'tool', text: `${tool}() → ${verdict}` };
  }
}

function short(text: string, max: number): string {
  const flat = text.replace(/\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

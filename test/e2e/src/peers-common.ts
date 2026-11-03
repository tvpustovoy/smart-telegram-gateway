// Подставная сеть агентов для настоящего PeerLink: общая у M14 и M15.

import fs from 'node:fs';
import type { Letter, NetworkPort, SendVerdict } from 'stg-link';

export const ADDRESS = 'AB'.repeat(32);

export class FakeNetwork implements NetworkPort {
  inbox: Letter[] = [];
  read: string[] = [];
  sent: Array<{ address: string; text: string; reply_to?: string }> = [];
  sentFiles: Array<{ address: string; name: string; mime: string | null; data: Buffer }> = [];
  blobs = new Map<string, Buffer>();
  fetchedFiles: string[] = [];
  verdict: SendVerdict | null = null;
  gate: Promise<void> | null = null;
  open: () => void = () => undefined;
  started = 0;
  private ring: (() => void) | null = null;

  async unread(): Promise<Letter[]> {
    return this.inbox.filter((l) => !this.read.includes(l.wire_id));
  }

  async consume(ids: string[]): Promise<void> {
    this.read.push(...ids);
  }

  async send(address: string, text: string, reply_to?: string): Promise<SendVerdict> {
    this.started++;
    if (this.gate) await this.gate;
    if (this.verdict) return this.verdict;
    this.sent.push({ address, text, ...(reply_to ? { reply_to } : {}) });
    return { sent: true, wire_id: `out-${this.sent.length}` };
  }

  async sendFile(address: string, file: string, name: string, mime: string | null): Promise<SendVerdict> {
    if (this.verdict) return this.verdict;
    this.sentFiles.push({ address, name, mime, data: fs.readFileSync(file) });
    return { sent: true, wire_id: `file-${this.sentFiles.length}` };
  }

  async fetchFile(wireId: string, dest: string): Promise<void> {
    this.fetchedFiles.push(wireId);
    const data = this.blobs.get(wireId);
    if (!data) throw new Error('файла нет в сети');
    fs.writeFileSync(dest, data);
  }

  async *wakes(signal: AbortSignal): AsyncIterable<void> {
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        this.ring = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (!signal.aborted) yield;
    }
  }

  async close(): Promise<void> {}

  /** Файл от агента; bytes — что заявлено, если нужно соврать. */
  file(wire_id: string, name: string, data: Buffer, from = ADDRESS, bytes = data.length): void {
    this.blobs.set(wire_id, data);
    this.inbox.push({ wire_id, from, kind: 'file', text: null, reply_to: null, file: { name, mime: null, bytes } });
    this.ring?.();
  }

  letter(wire_id: string, text: string, from = ADDRESS, reply_to: string | null = null): void {
    this.inbox.push({ wire_id, from, kind: 'text', text, reply_to });
    this.ring?.();
  }
}

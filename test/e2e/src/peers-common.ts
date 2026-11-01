// Подставная сеть агентов для настоящего PeerLink: общая у M14 и M15.

import type { Letter, NetworkPort, SendVerdict } from 'stg-link';

export const ADDRESS = 'AB'.repeat(32);

export class FakeNetwork implements NetworkPort {
  inbox: Letter[] = [];
  read: string[] = [];
  sent: Array<{ address: string; text: string }> = [];
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

  async send(address: string, text: string): Promise<SendVerdict> {
    this.started++;
    if (this.gate) await this.gate;
    if (this.verdict) return this.verdict;
    this.sent.push({ address, text });
    return { sent: true, wire_id: `out-${this.sent.length}` };
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

  letter(wire_id: string, text: string, from = ADDRESS, reply_to: string | null = null): void {
    this.inbox.push({ wire_id, from, kind: 'text', text, reply_to });
    this.ring?.();
  }
}

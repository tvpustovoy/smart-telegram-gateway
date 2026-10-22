// Один экземпляр (TECH-SPEC 5, «Один экземпляр»): до открытия базы шлюз подключается к gateway.sock. Ответили на
// ping — «уже запущен (pid N)», выход с кодом ≠ 0, без строк владельцу. Не ответили — старый сокет удаляется и
// создаётся заново; рядом gateway.pid, проверка — process.kill(pid, 0).

import fs from 'node:fs';
import net from 'node:net';
import { FrameDecoder, encodeFrame, writeFileAtomicSync } from 'stg-core';

// Замок одного экземпляра — в stg-core (его берёт и stg restore).
export { acquireInstanceLock } from 'stg-core';

/** Ответил ли кто-то на ping в сокете. */
export function pingSocket(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (alive: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(alive);
    };
    const sock = net.connect(socketPath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => sock.write(encodeFrame({ type: 'ping' })));
    sock.on('data', (chunk: Buffer) => {
      for (const f of decoder.push(chunk)) {
        if (f.kind !== 'line') continue;
        try {
          if ((JSON.parse(f.line) as { type?: unknown }).type === 'pong') finish(true);
        } catch {
          // не наш кадр
        }
      }
    });
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
  });
}

export function readPidFile(pidPath: string): number | null {
  try {
    const n = Number(fs.readFileSync(pidPath, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM — процесс есть, но чужой.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type InstanceCheck =
  | { state: 'running'; pid: number | null }
  | { state: 'free'; stalePid: number | null; staleAlive: boolean; staleSocket: boolean };

/** Проверить, не запущен ли уже шлюз на этой папке. Ничего не удаляет. */
export async function checkInstance(socketPath: string, pidPath: string): Promise<InstanceCheck> {
  const staleSocket = fs.existsSync(socketPath);
  if (staleSocket && (await pingSocket(socketPath))) return { state: 'running', pid: readPidFile(pidPath) };
  const stalePid = readPidFile(pidPath);
  const staleAlive = stalePid !== null && stalePid !== process.pid && processAlive(stalePid);
  return { state: 'free', stalePid, staleAlive, staleSocket };
}

export function writePidFile(pidPath: string): void {
  writeFileAtomicSync(pidPath, `${process.pid}\n`, 0o600);
}

/** Убрать сокет и pid-файл, если pid-файл наш. */
export function removeOwnFiles(socketPath: string, pidPath: string): void {
  if (readPidFile(pidPath) !== process.pid) return;
  for (const f of [socketPath, pidPath]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // уже нет
    }
  }
}

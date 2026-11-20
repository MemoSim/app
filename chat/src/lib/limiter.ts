/** Fair FIFO semaphores so many users share the GPU without overloading it (single-process). */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private max: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiters.shift()?.();
        });
      };
      if (this.active < this.max) return grant();
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        grant();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("aborted while waiting for the LLM queue"));
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  get queued(): number {
    return this.waiters.length;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __nlchatLimiter: { global: Semaphore; users: Map<string, Semaphore> } | undefined;
}

function state(max: number) {
  if (!globalThis.__nlchatLimiter) globalThis.__nlchatLimiter = { global: new Semaphore(max), users: new Map() };
  return globalThis.__nlchatLimiter;
}

/** Acquire one user slot (1 concurrent request per user) then one global slot. Returns a release function. */
export async function acquireLlmSlot(uid: string, maxGlobal: number, signal: AbortSignal): Promise<() => void> {
  const s = state(maxGlobal);
  let user = s.users.get(uid);
  if (!user) {
    user = new Semaphore(1);
    s.users.set(uid, user);
    if (s.users.size > 5000) s.users.delete(s.users.keys().next().value as string);
  }
  const releaseUser = await user.acquire(signal);
  try {
    const releaseGlobal = await s.global.acquire(signal);
    return () => {
      releaseGlobal();
      releaseUser();
    };
  } catch (e) {
    releaseUser();
    throw e;
  }
}

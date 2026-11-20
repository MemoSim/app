import { describe, expect, it } from "vitest";
import { Semaphore, acquireLlmSlot } from "@/lib/limiter";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("Semaphore", () => {
  it("never exceeds max concurrency and is FIFO", async () => {
    const s = new Semaphore(2);
    let active = 0, peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        s.acquire().then(async (release) => {
          order.push(i);
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
          release();
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("release is idempotent", async () => {
    const s = new Semaphore(1);
    const r = await s.acquire();
    r();
    r();
    const r2 = await s.acquire();
    let got = false;
    void s.acquire().then(() => (got = true));
    await tick();
    expect(got).toBe(false); // second release() did not leak a slot
    r2();
  });

  it("aborted waiters leave the queue", async () => {
    const s = new Semaphore(1);
    const hold = await s.acquire();
    const ac = new AbortController();
    const p = s.acquire(ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(s.queued).toBe(0);
    hold();
  });
});

describe("per-user + global limits", () => {
  it("one request at a time per user, max N overall", async () => {
    const ac = new AbortController();
    let active = 0, peak = 0;
    const run = async (uid: string) => {
      const release = await acquireLlmSlot(uid, 3, ac.signal);
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
      release();
    };
    await Promise.all(["a", "a", "a", "b", "b", "c", "d", "e", "f"].map(run));
    expect(peak).toBeLessThanOrEqual(3);

    // same user is serialized even with room globally
    let userActive = 0, userPeak = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const release = await acquireLlmSlot("solo", 10, ac.signal);
        userActive++;
        userPeak = Math.max(userPeak, userActive);
        await tick();
        userActive--;
        release();
      }),
    );
    expect(userPeak).toBe(1);
  });
});

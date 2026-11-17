// The receipt refresh controller (docs/specs/bills/split-screen.md,
// "Refresh"): interval, hidden tabs, focus, one read in flight, swapping
// state only on a change, and the failure paths. A fake env, no DOM.
import { describe, expect, it, vi } from "vitest";
import { REFRESH_MS, type RefreshEnv, startReceiptRefresh } from "../app/lib/use-receipt-refresh";

type Reply = { status: number; body?: unknown };

function fakeEnv(replies: Reply[] | (() => Promise<Reply>)) {
  const state = { visible: true, ticks: [] as (() => void)[], returns: [] as (() => void)[], reads: 0, interval: 0 };
  const env: RefreshEnv = {
    read: async () => {
      state.reads++;
      const reply = typeof replies === "function" ? await replies() : replies.shift() ?? { status: 200, body: detail(1) };
      return { status: reply.status, json: async () => reply.body };
    },
    now: () => 1234,
    visible: () => state.visible,
    every: (ms, run) => {
      state.interval = ms;
      state.ticks.push(run);
      return () => state.ticks.splice(state.ticks.indexOf(run), 1);
    },
    onReturn: (run) => {
      state.returns.push(run);
      return () => state.returns.splice(state.returns.indexOf(run), 1);
    },
  };
  return { env, state, tick: () => state.ticks.forEach((t) => t()), back: () => state.returns.forEach((r) => r()) };
}

function detail(revision: number, open = true, status = "DRAFT") {
  return { revision, picksOpenedAt: open ? "2026-11-16T00:00:00Z" : null, status };
}

function handlers() {
  return { onChange: vi.fn(), onRead: vi.fn(), onFailed: vi.fn(), onUnauthorized: vi.fn(), onMissing: vi.fn() };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("startReceiptRefresh", () => {
  it("reads every 5 s and hands over detail only when the revision changes", async () => {
    const f = fakeEnv([{ status: 200, body: detail(1) }, { status: 200, body: detail(2) }]);
    const h = handlers();
    startReceiptRefresh(f.env, detail(1), h);
    expect(f.state.interval).toBe(REFRESH_MS);
    expect(REFRESH_MS).toBe(5000);

    f.tick();
    await settle();
    expect(h.onRead).toHaveBeenCalledWith(1234);
    expect(h.onChange).not.toHaveBeenCalled();

    f.tick();
    await settle();
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(h.onChange.mock.calls[0][0]).toMatchObject({ revision: 2 });
  });

  it("notices picking paused elsewhere even though the revision is the same", async () => {
    const f = fakeEnv([{ status: 200, body: detail(1, false) }]);
    const h = handlers();
    startReceiptRefresh(f.env, detail(1), h);
    f.tick();
    await settle();
    expect(h.onChange).toHaveBeenCalledTimes(1);
  });

  it("doesn't read while the tab is hidden, and reads once when it comes back", async () => {
    const f = fakeEnv([]);
    const h = handlers();
    startReceiptRefresh(f.env, detail(1), h);
    f.state.visible = false;
    f.tick();
    f.tick();
    await settle();
    expect(f.state.reads).toBe(0);
    f.state.visible = true;
    f.back();
    await settle();
    expect(f.state.reads).toBe(1);
  });

  it("keeps at most one read in flight", async () => {
    let release!: () => void;
    const f = fakeEnv(() => new Promise<Reply>((resolve) => { release = () => resolve({ status: 200, body: detail(1) }); }));
    startReceiptRefresh(f.env, detail(1), handlers());
    f.tick();
    f.tick();
    f.back();
    expect(f.state.reads).toBe(1);
    release();
    await settle();
    f.tick();
    expect(f.state.reads).toBe(2);
  });

  it("reports 401, 404 and other failures without changing state", async () => {
    const f = fakeEnv([{ status: 401 }, { status: 404 }, { status: 500 }]);
    const h = handlers();
    startReceiptRefresh(f.env, detail(1), h);
    for (let i = 0; i < 3; i++) {
      f.tick();
      await settle();
    }
    expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(h.onMissing).toHaveBeenCalledTimes(1);
    expect(h.onFailed).toHaveBeenCalledTimes(1);
    expect(h.onChange).not.toHaveBeenCalled();
  });

  it("treats a network error as a failed read and retries on the next tick", async () => {
    let calls = 0;
    const f = fakeEnv(async () => {
      if (++calls === 1) throw new Error("offline");
      return { status: 200, body: detail(1) };
    });
    const h = handlers();
    startReceiptRefresh(f.env, detail(1), h);
    f.tick();
    await settle();
    expect(h.onFailed).toHaveBeenCalledTimes(1);
    f.tick();
    await settle();
    expect(h.onRead).toHaveBeenCalledTimes(1);
  });

  it("stops reading and listening once stopped", async () => {
    const f = fakeEnv([]);
    const h = handlers();
    const stop = startReceiptRefresh(f.env, detail(1), h);
    stop();
    expect(f.state.ticks).toHaveLength(0);
    expect(f.state.returns).toHaveLength(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import { GuestPickSession, DONE_FAILED, READ_FAILED, SAVE_FAILED } from "../app/p/[token]/guest-pick-session";
import { listenForGuestReturn } from "../app/p/[token]/guest-focus";
import { toGuestView, type GuestProjection } from "../app/p/[token]/guest-view";
import { finalizedProjection, guestProjection, withGuestPicks } from "./fixtures/guest-picks";

function harness(initial = guestProjection()) {
  const calls: {
    method: string; itemIds?: string[];
    reply: (status: number, data?: GuestProjection) => void;
    reject: () => void;
  }[] = [];
  const onError = vi.fn();
  const onFinalized = vi.fn();
  const session = new GuestPickSession(toGuestView(initial), {
    request: (method, itemIds) => new Promise((resolve, reject) => calls.push({
      method, itemIds,
      reply: (status, data) => resolve({ status, json: async () => data }),
      reject: () => reject(new Error("offline")),
    })),
    onError, onFinalized,
  });
  return { session, calls, onError, onFinalized, state: session.getSnapshot };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("guest pick request queue", () => {
  it("sends whole item sets and coalesces rapid taps without reverting the newest UI", async () => {
    const h = harness();
    const running = h.session.toggle("tea");
    expect(h.state().selected).toEqual(["rice", "tea"]);
    expect(h.calls[0]).toMatchObject({ method: "PUT", itemIds: ["rice", "tea"] });
    void h.session.toggle("rice");
    void h.session.toggle("tea");
    expect(h.state().selected).toEqual([]);
    expect(h.calls).toHaveLength(1);
    h.calls[0].reply(200, withGuestPicks(["rice", "tea"]));
    await settle();
    expect(h.state().selected).toEqual([]);
    expect(h.calls[1]).toMatchObject({ method: "PUT", itemIds: [] });
    h.calls[1].reply(200, withGuestPicks([]));
    await running;
    expect(h.state().selected).toEqual([]);
    expect(h.state().busy).toBe(false);
    expect(h.state().receipt.items[1].pickedBy).toEqual(["maya"]);
  });

  it("keeps successful earlier saves, discards queued taps on a failed PUT and requires GET recovery", async () => {
    const h = harness();
    const running = h.session.toggle("tea");
    void h.session.toggle("rice");
    h.calls[0].reply(200, withGuestPicks(["rice", "tea"]));
    await settle();
    void h.session.toggle("tea");
    h.calls[1].reply(500);
    await running;
    expect(h.calls).toHaveLength(2);
    expect(h.state()).toMatchObject({ selected: ["rice", "tea"], error: SAVE_FAILED, blocked: true });
    expect(h.onError).toHaveBeenCalledWith(SAVE_FAILED);
    await h.session.toggle("rice");
    await h.session.done();
    expect(h.calls).toHaveLength(2);
    const refresh = h.session.refresh();
    h.calls[2].reply(200, withGuestPicks(["tea"]));
    await refresh;
    expect(h.state()).toMatchObject({ selected: ["tea"], blocked: false, error: null });
  });

  it("waits for every save before done and clears submission when the guest changes a pick", async () => {
    const h = harness();
    const running = h.session.toggle("tea");
    void h.session.toggle("rice");
    void h.session.done();
    void h.session.toggle("tea"); // submission locks further taps
    expect(h.calls).toHaveLength(1);
    h.calls[0].reply(200, withGuestPicks(["rice", "tea"]));
    await settle();
    expect(h.calls[1]).toMatchObject({ method: "PUT", itemIds: ["tea"] });
    h.calls[1].reply(200, withGuestPicks(["tea"]));
    await settle();
    expect(h.calls[2].method).toBe("POST");
    expect(h.state().receipt.submitted).toBe(false);
    h.calls[2].reply(200, withGuestPicks(["tea"], { picksSubmittedAt: "2026-01-01T00:00:00Z" }));
    await running;
    expect(h.state().receipt.submitted).toBe(true);
    const changed = h.session.toggle("rice");
    expect(h.state().receipt.submitted).toBe(false);
    h.calls[3].reply(200, withGuestPicks(["tea", "rice"]));
    await changed;
    expect(h.state().receipt.submitted).toBe(false);
  });

  it("does not submit after a failed pending save", async () => {
    const h = harness();
    const running = h.session.toggle("tea");
    void h.session.done();
    h.calls[0].reject();
    await running;
    expect(h.calls.map((call) => call.method)).toEqual(["PUT"]);
    expect(h.state()).toMatchObject({ selected: ["rice"], blocked: true, submitting: false });
  });

  it("keeps done unconfirmed after a failed POST and allows an idempotent retry", async () => {
    const h = harness();
    const done = h.session.done();
    h.calls[0].reply(500);
    await done;
    expect(h.state()).toMatchObject({ error: DONE_FAILED, blocked: false });
    expect(h.state().receipt.submitted).toBe(false);
    const retry = h.session.done();
    h.calls[1].reply(200, guestProjection({ picksSubmittedAt: "2026-01-01T00:00:00Z" }));
    await retry;
    expect(h.state().receipt.submitted).toBe(true);
  });

  it("refreshes after a 409, pauses all writes, then resumes with preserved picks", async () => {
    const h = harness();
    const running = h.session.toggle("tea");
    h.calls[0].reply(409);
    await settle();
    expect(h.calls[1].method).toBe("GET");
    h.calls[1].reply(200, guestProjection({ pickingOpen: false }));
    await running;
    await h.session.toggle("tea");
    await h.session.done();
    expect(h.calls).toHaveLength(2);
    expect(h.state().receipt.pickingOpen).toBe(false);
    const refresh = h.session.refresh();
    h.calls[2].reply(200, guestProjection());
    await refresh;
    expect(h.state().selected).toEqual(["rice"]);
    const resumed = h.session.toggle("tea");
    h.calls[3].reply(200, withGuestPicks(["rice", "tea"]));
    await resumed;
    expect(h.state().selected).toEqual(["rice", "tea"]);
  });

  it("does not declare a link invalid for a removed item, but a GET 404 does", async () => {
    const h = harness();
    const running = h.session.toggle("tea");
    h.calls[0].reply(404);
    await settle();
    h.calls[1].reply(200, guestProjection({ items: [] }));
    await running;
    expect(h.state().invalid).toBe(false);
    expect(h.state().selected).toEqual([]);
    const refresh = h.session.refresh();
    h.calls[2].reply(404);
    await refresh;
    expect(h.state().invalid).toBe(true);
    await h.session.toggle("tea");
    expect(h.calls).toHaveLength(3);
  });

  it.each(["server", "network"])("keeps a failed %s refresh retryable and blocks writes until recovery", async (failure) => {
    const h = harness();
    const refresh = h.session.refresh();
    if (failure === "server") h.calls[0].reply(500);
    else h.calls[0].reject();
    await refresh;
    expect(h.state()).toMatchObject({ invalid: false, error: READ_FAILED, blocked: true });
    await h.session.done();
    expect(h.calls).toHaveLength(1);
    const retry = h.session.refresh();
    h.calls[1].reply(200, guestProjection());
    await retry;
    expect(h.state()).toMatchObject({ blocked: false, error: null });
  });

  it("serializes a focus read behind pending writes and coalesces trailing reads", async () => {
    const h = harness();
    const running = h.session.toggle("tea");
    void h.session.refresh();
    expect(h.calls).toHaveLength(1);
    h.calls[0].reply(200, withGuestPicks(["rice", "tea"]));
    await settle();
    expect(h.calls[1].method).toBe("GET");
    expect(h.state().blocked).toBe(true);
    void h.session.toggle("rice");
    expect(h.state().selected).toEqual(["rice", "tea"]);
    void h.session.refresh();
    void h.session.refresh();
    h.calls[1].reply(200, withGuestPicks(["rice", "tea"]));
    await settle();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].method).toBe("GET");
    h.calls[2].reply(200, withGuestPicks(["rice", "tea"]));
    await running;
    expect(h.calls).toHaveLength(3);
  });

  it("reads the reopened picking mode when a visible return arrives during a stale Editing GET", async () => {
    const editingSnapshot = guestProjection({ pickingOpen: false });
    const h = harness(editingSnapshot);
    const target = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const stop = listenForGuestReturn(target, doc, () => { void h.session.refresh(); });
    try {
      target.dispatchEvent(new Event("focus"));
      expect(h.calls).toHaveLength(1);
      const reopenedSnapshot = guestProjection({ pickingOpen: true });
      // The organizer opens picking after the first GET captured Editing.
      // Returning before it completes must schedule a newer snapshot.
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      target.dispatchEvent(new Event("focus"));
      expect(h.calls).toHaveLength(1); // No concurrent GETs.
      h.calls[0].reply(200, editingSnapshot);
      await settle();
      expect(h.state().receipt.pickingOpen).toBe(false);
      expect(h.state().blocked).toBe(true);
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1].method).toBe("GET");
      h.calls[1].reply(200, reopenedSnapshot);
      await settle();
      expect(h.state().receipt.pickingOpen).toBe(true);
      expect(h.state()).toMatchObject({ busy: false, blocked: false, selected: ["rice"] });
      expect(h.calls).toHaveLength(2); // Multiple return events coalesce.
    } finally { stop(); }
  });

  it("hands finalization back to the server and starts no more writes", async () => {
    const h = harness();
    const refresh = h.session.refresh();
    void h.session.refresh(); // Finalization discards the queued trailing GET.
    h.calls[0].reply(200, finalizedProjection());
    await refresh;
    expect(h.onFinalized).toHaveBeenCalledTimes(1);
    expect(h.state().receipt.finalized).toBe(true);
    await h.session.toggle("tea");
    await h.session.done();
    expect(h.calls).toHaveLength(1);
  });

  it.each(["server", "network"])("keeps a trailing return refresh after the current GET's %s failure", async (failure) => {
    const h = harness(guestProjection({ pickingOpen: false }));
    const refresh = h.session.refresh();
    void h.session.refresh();
    void h.session.refresh();
    expect(h.calls).toHaveLength(1);
    if (failure === "server") h.calls[0].reply(500);
    else h.calls[0].reject();
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].method).toBe("GET");
    expect(h.state().blocked).toBe(true);
    h.calls[1].reply(200, guestProjection());
    await refresh;
    expect(h.state()).toMatchObject({ busy: false, blocked: false, error: null });
    expect(h.state().receipt.pickingOpen).toBe(true);
    expect(h.calls).toHaveLength(2);
  });

  it("refreshes a conflicted done into the finalized server summary", async () => {
    const h = harness();
    const done = h.session.done();
    h.calls[0].reply(409);
    await settle();
    expect(h.calls[1].method).toBe("GET");
    h.calls[1].reply(200, finalizedProjection());
    await done;
    expect(h.onFinalized).toHaveBeenCalledTimes(1);
    expect(h.state().receipt.finalized).toBe(true);
    expect(h.state().submitting).toBe(false);
  });

  it("stops queued writes and notifications when the picker unmounts", async () => {
    const h = harness();
    const listener = vi.fn();
    const unsubscribe = h.session.subscribe(listener);
    const running = h.session.toggle("tea");
    void h.session.toggle("rice");
    listener.mockClear();
    h.session.setActive(false);
    unsubscribe();
    h.calls[0].reply(200, withGuestPicks(["rice", "tea"]));
    await running;
    expect(h.calls).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("guest focus refresh", () => {
  it("has no polling; reads on visible focus/return and removes listeners on cleanup", () => {
    vi.useFakeTimers();
    try {
      const target = new EventTarget();
      const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
      const refresh = vi.fn();
      const stop = listenForGuestReturn(target, doc, refresh);
      vi.advanceTimersByTime(60_000);
      expect(refresh).not.toHaveBeenCalled();
      target.dispatchEvent(new Event("focus"));
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      target.dispatchEvent(new Event("focus"));
      expect(refresh).toHaveBeenCalledTimes(1);
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(refresh).toHaveBeenCalledTimes(2);
      stop();
      target.dispatchEvent(new Event("focus"));
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

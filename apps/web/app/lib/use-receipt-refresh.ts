"use client";
// The one client refresh path for receipt screens (ADR-0018): while enabled,
// reads GET /api/receipts/[id] every 5 s while the tab is visible and right
// away when it regains focus, and hands over the detail only when the
// revision or the picking mode changed (docs/specs/bills/split-screen.md,
// "Refresh"). Push (ADR-0007) can replace this file without touching screens.
import { useEffect, useRef, useState } from "react";

export const REFRESH_MS = 5000;

type Detail = { revision: number; picksOpenedAt: string | null; status: string };

export type RefreshEnv = {
  read: () => Promise<{ status: number; json: () => Promise<unknown> }>;
  now: () => number;
  visible: () => boolean;
  every: (ms: number, run: () => void) => () => void;
  // Calls back when the tab regains focus or becomes visible.
  onReturn: (run: () => void) => () => void;
};

export type RefreshHandlers = {
  onChange: (detail: Detail & Record<string, unknown>) => void;
  onRead: (at: number) => void;
  onFailed: () => void;
  onUnauthorized: () => void;
  onMissing: () => void;
};

const stateKey = (d: Detail) => `${d.revision}|${d.picksOpenedAt === null ? "editing" : "open"}|${d.status}`;

// Starts polling; returns stop. `known` is the state the screen already shows.
export function startReceiptRefresh(env: RefreshEnv, known: Detail, handlers: RefreshHandlers): () => void {
  let current = stateKey(known);
  let inFlight = false;
  let stopped = false;

  async function tick() {
    if (stopped || inFlight || !env.visible()) return;
    inFlight = true;
    try {
      const res = await env.read();
      if (stopped) return;
      if (res.status === 401) return handlers.onUnauthorized();
      if (res.status === 404) return handlers.onMissing();
      if (res.status < 200 || res.status >= 300) return handlers.onFailed();
      const detail = (await res.json()) as Detail & Record<string, unknown>;
      if (stopped) return;
      handlers.onRead(env.now());
      const next = stateKey(detail);
      if (next !== current) {
        current = next;
        handlers.onChange(detail);
      }
    } catch {
      if (!stopped) handlers.onFailed();
    } finally {
      inFlight = false;
    }
  }

  const stopTimer = env.every(REFRESH_MS, () => void tick());
  const stopReturn = env.onReturn(() => void tick());
  return () => {
    stopped = true;
    stopTimer();
    stopReturn();
  };
}

export function browserRefreshEnv(receiptId: string): RefreshEnv {
  return {
    read: () => fetch(`/api/receipts/${encodeURIComponent(receiptId)}`, { cache: "no-store" }),
    now: () => Date.now(),
    visible: () => document.visibilityState === "visible",
    every: (ms, run) => {
      const id = window.setInterval(run, ms);
      return () => window.clearInterval(id);
    },
    onReturn: (run) => {
      const onVisibility = () => {
        if (document.visibilityState === "visible") run();
      };
      window.addEventListener("focus", run);
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        window.removeEventListener("focus", run);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
  };
}

// Polls while `enabled`. Returns whether the latest read failed. Handlers may
// change between renders; the latest is used.
export function useReceiptRefresh(
  receiptId: string,
  enabled: boolean,
  known: Detail,
  handlers: Pick<RefreshHandlers, "onChange" | "onUnauthorized" | "onMissing">,
): { failed: boolean } {
  const [failed, setFailed] = useState(false);
  const latest = useRef(handlers);
  latest.current = handlers;
  const knownKey = stateKey(known);
  const knownRef = useRef(known);
  knownRef.current = known;

  useEffect(() => {
    if (!enabled) return;
    setFailed(false);
    return startReceiptRefresh(browserRefreshEnv(receiptId), knownRef.current, {
      onChange: (d) => latest.current.onChange(d),
      onUnauthorized: () => latest.current.onUnauthorized(),
      onMissing: () => latest.current.onMissing(),
      onRead: () => setFailed(false),
      onFailed: () => setFailed(true),
    });
  }, [receiptId, enabled, knownKey]);

  return { failed };
}

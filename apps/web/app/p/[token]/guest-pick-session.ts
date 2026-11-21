// A single request queue for draft picks. The UI may keep accepting taps while
// PUT is pending; only the most recent complete set is sent next. No timers.
import { holderItems, toGuestView, type GuestProjection, type GuestView } from "./guest-view";

export type GuestPickState = {
  receipt: GuestView;
  selected: string[];
  busy: boolean;
  submitting: boolean;
  blocked: boolean;
  invalid: boolean;
  error: string | null;
};

export type GuestPickEnv = {
  request: (method: "GET" | "PUT" | "POST", itemIds?: string[]) => Promise<Pick<Response, "status" | "json">>;
  onError: (message: string) => void;
  onFinalized: () => void;
};

export const SAVE_FAILED = "Your picks couldn't be saved. Your last saved picks are shown. Check again before trying again.";
export const READ_FAILED = "Couldn't refresh your picks. Check your connection and try again.";
export const DONE_FAILED = "Your picks weren't submitted. Try I'm done again.";

export function initialGuestState(receipt: GuestView): GuestPickState {
  return { receipt, selected: holderItems(receipt), busy: false, submitting: false, blocked: false, invalid: false, error: null };
}

export class GuestPickSession {
  private state: GuestPickState;
  private confirmed: GuestView;
  private listeners = new Set<() => void>();
  private edit = 0;
  private savedEdit = 0;
  private wantsRead = false;
  private wantsDone = false;
  private running: Promise<void> | null = null;
  private active = true;

  constructor(initial: GuestView, private env: GuestPickEnv) {
    this.confirmed = initial;
    this.state = initialGuestState(initial);
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<GuestPickState>) {
    this.state = { ...this.state, ...patch };
    if (this.active) this.listeners.forEach((listener) => listener());
  }

  private canWrite() {
    return this.active && !this.state.invalid && !this.state.blocked && !this.state.submitting
      && this.confirmed.pickingOpen && !this.confirmed.finalized;
  }

  toggle(id: string): Promise<void> {
    if (!this.canWrite() || !this.confirmed.items.some((item) => item.id === id)) return Promise.resolve();
    this.edit++;
    const selected = this.state.selected.includes(id)
      ? this.state.selected.filter((itemId) => itemId !== id) : [...this.state.selected, id];
    this.update({ selected, receipt: { ...this.state.receipt, submitted: false }, error: null });
    return this.start();
  }

  done(): Promise<void> {
    if (!this.canWrite()) return Promise.resolve();
    this.wantsDone = true;
    this.update({ submitting: true, error: null });
    return this.start();
  }

  refresh(): Promise<void> {
    if (!this.active || this.state.invalid || this.confirmed.finalized) return Promise.resolve();
    // Keep one trailing read when focus/visibility returns during a GET;
    // that request may already have captured an out-of-date picking mode.
    this.wantsRead = true;
    this.update({ blocked: true });
    return this.start();
  }

  // Effect cleanup prevents queued work after unmount. An already-sent request
  // may still commit; reopening always starts from the server projection.
  setActive(active: boolean) { this.active = active; }

  private start(): Promise<void> {
    if (this.running) return this.running;
    this.update({ busy: true });
    this.running = this.drain().finally(() => {
      this.running = null;
      this.update({ busy: false, submitting: false });
    });
    return this.running;
  }

  private adopt(receipt: GuestView, preserveTaps = false) {
    this.confirmed = receipt;
    this.update({
      receipt: preserveTaps ? { ...receipt, submitted: false } : receipt,
      ...(preserveTaps ? {} : { selected: holderItems(receipt) }),
      error: null, blocked: this.wantsRead,
    });
    if (receipt.finalized) {
      this.wantsDone = false;
      this.wantsRead = false;
      this.savedEdit = this.edit;
      if (this.active) this.env.onFinalized();
    }
  }

  private fail(message: string, blocked: boolean) {
    this.savedEdit = this.edit;
    this.wantsDone = false;
    this.update({ receipt: this.confirmed, selected: holderItems(this.confirmed), error: message, blocked });
    if (this.active) this.env.onError(message);
  }

  private async drain() {
    while (this.active && !this.state.invalid && !this.confirmed.finalized) {
      const method = this.edit !== this.savedEdit ? "PUT" : this.wantsRead ? "GET" : this.wantsDone ? "POST" : null;
      if (method === null) break;
      const version = this.edit;
      const selected = [...this.state.selected];
      if (method === "GET") this.wantsRead = false;
      if (method === "POST") this.wantsDone = false;
      try {
        const reply = await this.env.request(method, method === "PUT" ? selected : undefined);
        if (!this.active) break;
        if (reply.status === 200) {
          const receipt = toGuestView(await reply.json() as GuestProjection);
          if (method === "PUT") this.savedEdit = version;
          const laterTaps = method === "PUT" && version !== this.edit && receipt.pickingOpen;
          if (!receipt.pickingOpen) this.savedEdit = this.edit;
          this.adopt(receipt, laterTaps);
        } else if (method !== "GET" && (reply.status === 409 || reply.status === 404)) {
          // A 404 can mean an item disappeared, not that the link was revoked.
          // Re-read before deciding; conflicts likewise require a fresh mode.
          this.fail(SAVE_FAILED, true);
          this.wantsRead = true;
        } else if (method === "GET" && reply.status === 404) {
          this.wantsDone = false;
          this.wantsRead = false;
          this.update({ invalid: true, blocked: true, error: null });
        } else {
          this.fail(method === "GET" ? READ_FAILED : method === "POST" ? DONE_FAILED : SAVE_FAILED, method !== "POST");
          if (method !== "GET") this.wantsRead = false;
        }
      } catch {
        // Even a rejected connection may have committed. Require a successful
        // GET before another write, including a retry of an uncertain done.
        this.fail(method === "GET" ? READ_FAILED : method === "POST" ? DONE_FAILED : SAVE_FAILED, true);
        if (method !== "GET") this.wantsRead = false;
      }
    }
  }
}

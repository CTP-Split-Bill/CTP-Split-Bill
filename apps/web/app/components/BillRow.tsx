// One receipt on the home list (docs/specs/components.md, "BillRow"). Not a
// link and no menu: the list wraps it and adds the ⋯ beside it.
export type BillRowProps = {
  name: string;
  untitled: boolean;
  total: string;
  date: string;
  status: string;
  // Whose move it is; colours the status. The status text says it too.
  state: "your-move" | "waiting" | "done";
  // A draft's finished steps out of five, or null once finalized.
  stepsDone: number | null;
};

const STATE_INK: Record<BillRowProps["state"], string> = {
  "your-move": "text-brand",
  waiting: "text-warning",
  done: "text-ink-muted",
};
const STATE_DOT: Record<BillRowProps["state"], string> = {
  "your-move": "bg-brand",
  waiting: "bg-warning",
  done: "bg-ink-muted",
};

export function BillRow({ name, untitled, total, date, status, state, stepsDone }: BillRowProps) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className={untitled ? "truncate font-medium text-ink-muted" : "truncate font-semibold text-ink"}>
          {name}
        </span>
        <span className="shrink-0 font-semibold whitespace-nowrap tabular-nums">{total}</span>
      </div>
      <p className="flex min-w-0 items-center gap-2 text-sm">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${STATE_DOT[state]}`} />
        <span className={`truncate font-medium ${STATE_INK[state]}`}>{status}</span>
        <span className="shrink-0 text-ink-muted">· {date}</span>
      </p>
      {stepsDone !== null && (
        <div aria-hidden className="flex gap-1 pt-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={`h-1 flex-1 rounded-full ${i < stepsDone ? "bg-brand" : "bg-line"}`} />
          ))}
        </div>
      )}
    </div>
  );
}

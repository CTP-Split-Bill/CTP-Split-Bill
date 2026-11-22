// Rendering checks for the presentational components (docs/specs/components.md).
// Pure props in, markup out — no database, no session, no DOM.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Card, CardContent, CardFooter, CardHeader } from "../app/components/ui/card";
import { BillRow } from "../app/components/BillRow";
import { EmptyState } from "../app/components/EmptyState";
import { ErrorState } from "../app/components/ErrorState";
import { LoadingState } from "../app/components/LoadingState";
import { PersonAvatar } from "../app/components/PersonAvatar";
import { UserMenu } from "../app/components/UserMenu";
import RootError from "../app/error";

// The root error boundary reads the app router; there is none in a static render.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("Card", () => {
  it("renders its slots' children in the order given", () => {
    const html = renderToStaticMarkup(
      h(Card, null, h(CardHeader, null, "head"), h(CardContent, null, "body"), h(CardFooter, null, "foot")),
    );
    expect(html.indexOf("head")).toBeGreaterThan(-1);
    expect(html.indexOf("head")).toBeLessThan(html.indexOf("body"));
    expect(html.indexOf("body")).toBeLessThan(html.indexOf("foot"));
  });

  it("styles only through the design tokens", () => {
    const html = renderToStaticMarkup(h(Card, null, h(CardContent, null, "x")));
    expect(html).toContain("bg-card");
    expect(html).toContain("text-card-foreground");
    expect(html).not.toMatch(/class=""/);
  });
});

describe("PersonAvatar", () => {
  it("is decorative without a label, and a named image with one", () => {
    const plain = renderToStaticMarkup(h(PersonAvatar, { initial: "M", color: 2 }));
    expect(plain).toMatch(/^<span aria-hidden="true" class="[^"]*size-7[^"]*bg-person-2[^"]*">M<\/span>$/);
    const named = renderToStaticMarkup(h(PersonAvatar, { initial: "M", color: 2, label: "Maya", size: "lg", outlined: true }));
    expect(named).toMatch(/^<span role="img" aria-label="Maya" title="Maya" class="[^"]*size-12[^"]*ring-surface[^"]*bg-person-2[^"]*">/);
  });

  it("wraps colors past the palette", () => {
    expect(renderToStaticMarkup(h(PersonAvatar, { initial: "G", color: 7 }))).toContain("bg-person-1");
  });
});

describe("BillRow", () => {
  it("renders the display strings it is given, untouched", () => {
    const html = renderToStaticMarkup(
      h(BillRow, { name: "Noodle Bar", untitled: false, total: "$12.50", date: "Nov 2, 2026", status: "Next: check items", state: "your-move", stepsDone: 1 }),
    );
    for (const text of ["Noodle Bar", "$12.50", "Next: check items", "· Nov 2, 2026"]) {
      expect(html).toContain(text);
    }
  });

  it("colours the status by whose move it is", () => {
    const row = (state: "your-move" | "waiting" | "done") =>
      renderToStaticMarkup(h(BillRow, { name: "N", untitled: false, total: "—", date: "x", status: "S", state, stepsDone: null }));
    expect(row("your-move")).toContain('class="truncate font-medium text-brand">S');
    expect(row("waiting")).toContain('class="truncate font-medium text-warning">S');
    expect(row("done")).toContain('class="truncate font-medium text-ink-muted">S');
  });

  it("fills the step bar up to the steps done, and draws none once finalized", () => {
    const html = renderToStaticMarkup(h(BillRow, { name: "N", untitled: false, total: "—", date: "x", status: "S", state: "your-move", stepsDone: 2 }));
    expect(count(html, "h-1 flex-1 rounded-full bg-brand")).toBe(2);
    expect(count(html, "h-1 flex-1 rounded-full bg-line")).toBe(3);
    const done = renderToStaticMarkup(h(BillRow, { name: "N", untitled: false, total: "—", date: "x", status: "S", state: "done", stepsDone: null }));
    expect(done).not.toContain("h-1 flex-1");
  });

  it("mutes the name of an untitled receipt", () => {
    const named = renderToStaticMarkup(h(BillRow, { name: "Noodle Bar", untitled: false, total: "—", date: "x", status: "y", state: "done", stepsDone: null }));
    const untitled = renderToStaticMarkup(h(BillRow, { name: "Untitled receipt", untitled: true, total: "—", date: "x", status: "y", state: "done", stepsDone: null }));
    expect(named).toMatch(/class="truncate font-semibold text-ink">Noodle Bar/);
    expect(untitled).toMatch(/class="truncate font-medium text-ink-muted">Untitled receipt/);
  });
});

describe("LoadingState", () => {
  it("announces its label and draws exactly the requested skeleton rows", () => {
    const html = renderToStaticMarkup(h(LoadingState, { label: "Loading bills", rows: 4 }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading bills");
    expect(count(html, 'data-slot="skeleton"')).toBe(4);
  });

  it("defaults to three rows", () => {
    const html = renderToStaticMarkup(h(LoadingState, { label: "Loading" }));
    expect(count(html, 'data-slot="skeleton"')).toBe(3);
  });
});

describe("EmptyState", () => {
  it("puts actionId on the action, link or button, so focus can move to it", () => {
    const link = renderToStaticMarkup(h(EmptyState, { title: "t", message: "m", actionLabel: "Go", actionHref: "/x", actionId: "go" }));
    expect(link).toMatch(/<a[^>]*id="go"[^>]*>Go<\/a>/);
    const button = renderToStaticMarkup(h(EmptyState, { title: "t", message: "m", actionLabel: "Add", onAction: () => {}, actionId: "add" }));
    expect(button).toMatch(/<button[^>]*id="add"[^>]*>Add<\/button>/);
  });

  it("renders its copy and one primary action link", () => {
    const html = renderToStaticMarkup(
      h(EmptyState, {
        title: "No bills yet",
        message: "Scan a receipt to split it.",
        actionLabel: "Scan a receipt",
        actionHref: "/receipts/new",
      }),
    );
    expect(html).toContain("No bills yet");
    expect(html).toContain("Scan a receipt to split it.");
    expect(html).toMatch(/<a[^>]*href="\/receipts\/new"[^>]*>Scan a receipt<\/a>/);
    expect(html).not.toContain("<button");
  });

  it("renders a button instead of a link when given onAction", () => {
    const html = renderToStaticMarkup(
      h(EmptyState, {
        title: "No one's on this receipt yet",
        message: "Add the people splitting it.",
        actionLabel: "Add person",
        onAction: () => {},
      }),
    );
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Add person<\/button>/);
    expect(html).not.toContain("<a");
  });
});

describe("ErrorState", () => {
  it("renders an alert with its copy and a retry button", () => {
    const html = renderToStaticMarkup(
      h(ErrorState, { title: "Bills did not load", message: "Check your connection.", onRetry: () => {} }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Bills did not load");
    expect(html).toContain("Check your connection.");
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
  });
});

describe("UserMenu", () => {
  it("renders a menu trigger showing the name", () => {
    const html = renderToStaticMarkup(h(UserMenu, { name: "Andrew Jiang", signOutAction: async () => {} }));
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*>/);
    expect(html).toContain("Andrew Jiang");
    expect(html).toContain("min-h-11");
  });
});

describe("root error boundary", () => {
  it("shows generic copy and never the error's message", () => {
    const html = renderToStaticMarkup(
      h(RootError, { error: new Error("connect ECONNREFUSED 127.0.0.1:5433"), reset: () => {} }),
    );
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Try again");
    expect(html).not.toContain("ECONNREFUSED");
  });
});

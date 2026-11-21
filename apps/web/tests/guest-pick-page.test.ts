import { createElement as h, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizedProjection, guestProjection } from "./fixtures/guest-picks";

const mocks = vi.hoisted(() => ({
  getPicks: vi.fn(), getCurrentUser: vi.fn(), currentUserId: vi.fn(), headers: vi.fn(), refresh: vi.fn(),
}));
vi.mock("@project/domain", async (original) => ({
  ...await original<typeof import("@project/domain")>(), getPicks: mocks.getPicks, getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@project/auth", () => ({ currentUserId: mocks.currentUserId, signOut: vi.fn(), auth: (handler: unknown) => handler }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));

const { ApiError } = await import("@project/domain");
const { GuestContent } = await import("../app/p/[token]/GuestContent");
const { default: GuestPage, metadata, dynamic } = await import("../app/p/[token]/page");
const { GuestPicker } = await import("../app/p/[token]/GuestPicker");
const { SplitSummary } = await import("../app/p/[token]/SplitSummary");
const { default: GuestError } = await import("../app/p/[token]/error");
const { guestMoney, toGuestView } = await import("../app/p/[token]/guest-view");
const { default: middleware } = await import("../middleware");
const { default: RootLayout } = await import("../app/layout");
const { default: config } = await import("../next.config");
const { GUEST_PAGE_HEADER } = await import("../app/lib/page-access");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.headers.mockResolvedValue(new Headers());
});
const render = async () => renderToStaticMarkup(await GuestContent({ token: "personal-secret" }));

describe("guest page", () => {
  it("loads only the token projection and sends the draft to a narrow client picker", async () => {
    mocks.getPicks.mockResolvedValue(guestProjection());
    const page = await GuestPage({ params: Promise.resolve({ token: "personal-secret" }) });
    expect(page.props.children.props.token).toBe("personal-secret");
    const content = await GuestContent({ token: "personal-secret" });
    expect(content.type).toBe(GuestPicker);
    expect(content.key).toBe("personal-secret"); // A different holder must get a fresh request queue.
    const html = renderToStaticMarkup(content);
    expect(mocks.getPicks).toHaveBeenCalledWith("personal-secret");
    expect(mocks.currentUserId).not.toHaveBeenCalled();
    expect(html).toContain("What did you have, Sam?");
    expect(html).toContain('role="checkbox" aria-checked="true"');
    expect(html).toContain('role="checkbox" aria-checked="false"');
    expect(html).toContain('for="pick-rice"');
    expect(html).toContain('aria-labelledby="pick-name-rice"');
    expect(html).toContain('aria-describedby="pick-detail-rice"');
    expect(html).toContain("min-h-14 w-full");
    expect(html).toContain("Also picked by Maya");
    expect(html).toMatch(/<span aria-hidden="true"[^>]*><span title="Maya" class="[^"]*bg-person-\d[^"]*">M<\/span>/);
    expect(html).toContain("Qty 2 · $12.50");
    expect(html).toContain("I&#x27;m done");
    expect(html).not.toContain("/login");
  });

  it("renders Editing read-only with the precise message, Check again and no done action", async () => {
    mocks.getPicks.mockResolvedValue(guestProjection({ pickingOpen: false }));
    const html = await render();
    expect(html).toContain("The organizer is making changes. Check back in a minute.");
    expect(html).toContain("Check again");
    expect(html).not.toContain("I&#x27;m done");
    const checkboxes = html.match(/<button[^>]*role="checkbox"[^>]*>/g) ?? [];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every((box) => box.includes('disabled=""'))).toBe(true);
  });

  it("shows confirmed submission and permits changing picks", async () => {
    mocks.getPicks.mockResolvedValue(guestProjection({ picksSubmittedAt: new Date() }));
    const html = await render();
    expect(html).toContain("Your picks are submitted.");
    expect(html).toContain("Picks submitted");
    const checkboxes = html.match(/<button[^>]*role="checkbox"[^>]*>/g) ?? [];
    expect(checkboxes.every((box) => !box.includes('disabled=""'))).toBe(true);
  });

  it("provides an actionable empty state", async () => {
    mocks.getPicks.mockResolvedValue(guestProjection({ items: [] }));
    const html = await render();
    expect(html).toContain("No items yet");
    expect(html).toContain("Check again");
  });

  it("renders a generic invalid link only for the token 404 family", async () => {
    mocks.getPicks.mockRejectedValue(new ApiError("NOT_FOUND", "Link not found", 404));
    const html = await render();
    expect(html).toContain("This link isn&#x27;t valid");
    expect(html).not.toContain("Noodle Cafe");
    expect(html).not.toContain("personal-secret");
    expect(html).not.toContain("Try again");
  });

  it.each([new Error("database details personal-secret"), new ApiError("INTERNAL", "private details", 500)])(
    "keeps transient failures retryable and hides their details", async (error) => {
      mocks.getPicks.mockRejectedValue(error);
      const html = await render();
      expect(html).toContain("Couldn&#x27;t load this receipt");
      expect(html).toContain("Try again");
      expect(html).not.toContain("isn&#x27;t valid");
      expect(html).not.toContain(error.message);
      expect(html).not.toContain("personal-secret");
    },
  );

  it("keeps all metadata generic and disables indexing", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata).toMatchObject({ title: "Split Bill", description: "Split Bill", referrer: "no-referrer",
      robots: { index: false, follow: false }, openGraph: { title: "Split Bill", description: "Split Bill" },
      twitter: { title: "Split Bill", description: "Split Bill" } });
    const html = renderToStaticMarkup(h(GuestError, { error: new Error("secret") }));
    expect(html).not.toContain("secret");
  });
});

describe("finalized summary", () => {
  it("renders every participant and payer in a server composition without a picker", async () => {
    mocks.getPicks.mockResolvedValue(finalizedProjection());
    const content = await GuestContent({ token: "personal-secret" });
    expect(content.type).toBe(SplitSummary);
    const html = renderToStaticMarkup(content);
    for (const text of ["The split", "Pay Organizer", "Organizer", "Sam", "Maya", "$8.50", "$4.00", "Settled", "Still owes"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(/<button|<input|role="checkbox"|personal-secret|Check again/);
  });

  it("handles a nullable payer without inventing one", () => {
    const html = renderToStaticMarkup(h(SplitSummary, { receipt: toGuestView({ ...finalizedProjection(), paidBy: null }) }));
    expect(html).toContain("Check with the organizer about who to pay.");
    expect(html).not.toContain("Pay null");
  });

  it("formats exact decimal amounts in the receipt currency and preserves item ordering", () => {
    expect(guestMoney("90071992547409.99", "USD")).toBe("$90,071,992,547,409.99");
    expect(guestMoney("12.05", "EUR")).toBe("€12.05");
    expect(guestMoney("0.01", "USD")).toBe("$0.01");
    expect(guestMoney(null, "USD")).toBe("—");
    const data = guestProjection();
    const view = toGuestView({ ...data, items: [...data.items].reverse() });
    expect(view.items.map((item) => item.id)).toEqual(["rice", "tea"]);
  });
});

function findComponent(node: ReactNode, name: string): ReactElement | undefined {
  if (Array.isArray(node)) return node.map((child) => findComponent(child, name)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (typeof node.type === "function" && node.type.name === name) return node;
  return findComponent(node.props.children, name);
}

describe("guest page shell and headers", () => {
  it("hides the account slot without reading a session or profile", async () => {
    mocks.headers.mockResolvedValue(new Headers({ [GUEST_PAGE_HEADER]: "1" }));
    const slot = findComponent(RootLayout({ children: null }), "AccountSlot")!;
    expect(slot).toBeDefined();
    expect(await (slot.type as () => Promise<unknown>)()).toBeNull();
    expect(mocks.currentUserId).not.toHaveBeenCalled();
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it("overwrites the shell hint so clients cannot impersonate another page surface", async () => {
    const run = middleware as unknown as (request: NextRequest & { auth: unknown }) => Response;
    for (const [path, supplied, expected] of [["/p/token", "0", "1"], ["/receipts/new", "1", "0"]]) {
      const request = Object.assign(new NextRequest(`http://test${path}`, { headers: { [GUEST_PAGE_HEADER]: supplied } }), { auth: {} });
      const response = await run(request);
      expect(response.headers.get(`x-middleware-request-${GUEST_PAGE_HEADER}`)).toBe(expected);
    }
    const anonymous = Object.assign(new NextRequest("http://test/p/token"), { auth: null });
    expect((await run(anonymous)).headers.get("location")).toBeNull();
  });

  it("applies HTML privacy headers to the personal guest path", async () => {
    const rules = await config.headers!();
    const personal = rules.find((rule) => rule.source === "/p/:path*");
    expect(personal?.headers).toEqual(expect.arrayContaining([
      { key: "Cache-Control", value: "no-store" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex" },
    ]));
  });
});

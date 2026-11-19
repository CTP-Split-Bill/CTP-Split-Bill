// Sign-in page, its GitHub action and the middleware page-access rules
// (docs/specs/auth/sign-in.md). Auth.js itself is mocked; no session or network.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ signIn: vi.fn(async () => {}) }));
vi.mock("@project/auth", () => authMock);

const { pageRedirect, safeCallbackPath } = await import("../app/lib/page-access");
const { signInWithGitHub } = await import("../app/login/actions");
const { default: LoginPage } = await import("../app/login/page");
const { default: nextConfig } = await import("../next.config");

const render = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));

beforeEach(() => authMock.signIn.mockClear());

describe("pageRedirect", () => {
  it("keeps token-bearing page and API URLs out of Next's request log", () => {
    const logging = nextConfig.logging;
    const incoming = logging && logging.incomingRequests;
    const ignore = typeof incoming === "object" ? incoming.ignore ?? [] : [];
    for (const path of ["/g/secret", "/p/secret", "/api/groups/secret", "/api/groups/secret/claim", "/api/picks/secret/done"]) {
      expect(ignore.some((pattern) => pattern.test(path))).toBe(true);
    }
    expect(ignore.some((pattern) => pattern.test("/api/receipts/abc"))).toBe(false);
  });

  it("allows group page paths without making similarly named routes public", () => {
    expect(pageRedirect("/g/token", "", false)).toBeNull();
    for (const path of ["/g", "/group", "/groups/token", "/guest", "/receipts/abc"]) {
      expect(pageRedirect(path, "", false)).toBe(`/login?callbackUrl=${encodeURIComponent(path)}`);
    }
  });

  it("allows personal guest links without exposing similarly named or organizer pages", () => {
    expect(pageRedirect("/p/token", "", false)).toBeNull();
    for (const path of ["/p", "/people", "/picks/token", "/participants", "/receipts/new"]) {
      expect(pageRedirect(path, "", false)).toBe(`/login?callbackUrl=${encodeURIComponent(path)}`);
    }
  });

  it("sends signed-out visitors of protected pages to /login with their destination", () => {
    expect(pageRedirect("/receipts/abc", "?tab=bills", false)).toBe("/login?callbackUrl=%2Freceipts%2Fabc%3Ftab%3Dbills");
  });

  it("lets signed-in visitors through protected pages", () => {
    expect(pageRedirect("/receipts/abc", "", true)).toBeNull();
  });

  it("keeps the landing page public", () => {
    expect(pageRedirect("/", "", false)).toBeNull();
    expect(pageRedirect("/", "", true)).toBeNull();
  });

  it("shows /login to signed-out visitors and sends signed-in visitors to their destination", () => {
    expect(pageRedirect("/login", "?callbackUrl=%2Freceipts", false)).toBeNull();
    expect(pageRedirect("/login", "?callbackUrl=%2Freceipts", true)).toBe("/receipts");
    expect(pageRedirect("/login", "", true)).toBe("/");
  });
});

describe("safeCallbackPath", () => {
  it.each(["/receipts", "/receipts/abc?tab=bills"])("keeps same-origin path %s", (path) => {
    expect(safeCallbackPath(path)).toBe(path);
  });

  it.each([null, undefined, "", "https://evil.example", "//evil.example", "/\\evil.example", "receipts", "/login", "/login?callbackUrl=/x"])(
    "falls back to / for %j", (value) => {
      expect(safeCallbackPath(value)).toBe("/");
    },
  );
});

describe("signInWithGitHub", () => {
  it("starts GitHub OAuth returning to the sanitized destination", async () => {
    await signInWithGitHub("/receipts/abc");
    expect(authMock.signIn).toHaveBeenCalledWith("github", { redirectTo: "/receipts/abc" });
    await signInWithGitHub("https://evil.example");
    expect(authMock.signIn).toHaveBeenLastCalledWith("github", { redirectTo: "/" });
  });
});

describe("LoginPage", () => {
  it("renders the centered card with the GitHub message and button", async () => {
    const html = await render();
    expect(html).toContain("Sign in to Split Bill");
    expect(html).toContain("You need to sign in with GitHub to continue.");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Continue with GitHub<\/button>/);
    expect(html).toContain("items-center justify-center");
    expect(html).not.toContain('role="alert"');
  });

  it("explains a missing verified email and falls back to a generic error", async () => {
    expect(await render({ error: "AccessDenied" })).toContain("didn&#x27;t share a verified email address");
    const generic = await render({ error: "OAuthCallbackError" });
    expect(generic).toContain('role="alert"');
    expect(generic).toContain("Sign-in didn&#x27;t complete. Please try again.");
  });
});

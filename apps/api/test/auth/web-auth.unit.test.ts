import { createElement, type AnchorHTMLAttributes } from "react";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AuthPage } from "../../../web/src/features/auth/AuthPage";
import { LogoutPage } from "../../../web/src/features/auth/LogoutPage";
import { RoleHome } from "../../../web/src/features/auth/RoleHome";
import { apiFetch, apiFetchBlob, isAbortError } from "../../../web/src/lib/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement("a", props),
}));

it("renders the same initial auth markup without reading browser session storage", () => {
  const pages = [
    createElement(AuthPage, { mode: "login" }),
    createElement(AuthPage, { mode: "register" }),
    createElement(LogoutPage),
    createElement(RoleHome, { role: "SHIPPER" }),
    createElement(RoleHome, { role: "CARRIER" }),
    createElement(RoleHome, { role: "ADMIN" }),
  ];
  const serverMarkup = pages.map((page) => renderToString(page));
  const roleMarkup = '<main><p role="status">Checking your session…</p></main>';
  expect(serverMarkup.slice(3)).toEqual([roleMarkup, roleMarkup, roleMarkup]);

  const readStorage = vi.fn(() => { throw new Error("Render tried to read sessionStorage"); });
  vi.stubGlobal("window", Object.defineProperty({}, "sessionStorage", { get: readStorage }));
  try {
    expect(pages.map((page) => renderToString(page))).toEqual(serverMarkup);
    expect(readStorage).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("recognizes aborts separately from other request errors", () => {
  expect(isAbortError(new DOMException("Request canceled", "AbortError"))).toBe(true);
  expect(isAbortError({ name: "AbortError" })).toBe(true);
  expect(isAbortError(new TypeError("Network failed"))).toBe(false);
});

it("uses the current bearer token for binary requests and preserves errors from the API envelope", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } }))
    .mockResolvedValueOnce(Response.json({ error: { code: "NOT_FOUND", message: "No certificate.", requestId: "test-request" } }, { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("window", { sessionStorage: { getItem: () => "test-token" } });
  try {
    const blob = await apiFetchBlob("/carriers/me/insurance");
    expect(blob.type).toBe("application/pdf");
    await expect(blob.text()).resolves.toBe("%PDF-1.7");
    expect(fetch.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer test-token");
    await expect(apiFetchBlob("/carriers/me/insurance")).rejects.toMatchObject({
      name: "ApiError", status: 404, code: "NOT_FOUND", message: "No certificate.", requestId: "test-request",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("preserves AbortError when either response body read is aborted", async () => {
  const failure = new DOMException("Request canceled", "AbortError");
  const abort = vi.fn().mockRejectedValue(failure);
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: abort, blob: abort });
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(apiFetch("/users/me")).rejects.toBe(failure);
    await expect(apiFetchBlob("/carriers/me/insurance")).rejects.toBe(failure);
    fetch.mockResolvedValue({ ok: false, json: abort });
    await expect(apiFetchBlob("/carriers/me/insurance")).rejects.toBe(failure);
  } finally {
    vi.unstubAllGlobals();
  }
});

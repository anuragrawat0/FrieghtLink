import { createElement, type AnchorHTMLAttributes } from "react";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AuthPage } from "../../../web/src/features/auth/AuthPage";
import { LogoutPage } from "../../../web/src/features/auth/LogoutPage";
import { RoleHome } from "../../../web/src/features/auth/RoleHome";
import { isAbortError } from "../../../web/src/features/auth/session";

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

const accessTokenKey = "freightlink.accessToken";

export function getAccessToken() {
  return typeof window === "undefined" ? null : window.sessionStorage.getItem(accessTokenKey);
}

export function setAccessToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token === null) window.sessionStorage.removeItem(accessTokenKey);
  else window.sessionStorage.setItem(accessTokenKey, token);
}

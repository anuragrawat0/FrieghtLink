import { apiBaseUrl } from "./config";
import { getAccessToken } from "./session";

type ApiResult<T> = { data: T; meta?: { limit: number; offset: number; hasMore: boolean } };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(path: `/${string}`, init: RequestInit = {}): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(`${apiBaseUrl}${path}`, { cache: "no-store", ...init, headers });
  const body = await response.json().catch(() => null) as (ApiResult<T> & {
    error?: { code?: string; message?: string; requestId?: string };
  }) | null;
  if (!response.ok || !body || typeof body !== "object" || !("data" in body)) {
    throw new ApiError(response.status, body?.error?.code ?? "INTERNAL_ERROR",
      body?.error?.message ?? "The API response could not be read.", body?.error?.requestId);
  }
  return body;
}

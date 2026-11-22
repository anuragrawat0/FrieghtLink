import { apiBaseUrl } from "./config";
import { getAccessToken } from "./session";

export type ApiResult<T> = { data: T; meta?: { limit: number; offset: number; hasMore: boolean } };
type ApiErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function requestApi(path: `/${string}`, init: RequestInit, accept: string) {
  const headers = new Headers(init.headers);
  headers.set("Accept", accept);
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  return fetch(`${apiBaseUrl}${path}`, { cache: "no-store", ...init, headers });
}

async function readJson<T>(response: Response): Promise<(T & ApiErrorEnvelope) | null> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

function apiError(response: Response, body: ApiErrorEnvelope | null) {
  return new ApiError(response.status, body?.error?.code ?? "INTERNAL_ERROR",
    body?.error?.message ?? "The API response could not be read.", body?.error?.requestId);
}

export async function apiFetch<T>(path: `/${string}`, init: RequestInit = {}): Promise<ApiResult<T>> {
  const response = await requestApi(path, init, "application/json");
  const body = await readJson<ApiResult<T>>(response);
  if (!response.ok || !body || typeof body !== "object" || !("data" in body)) {
    throw apiError(response, body);
  }
  return body;
}

export async function apiFetchBlob(path: `/${string}`, init: RequestInit = {}): Promise<Blob> {
  const response = await requestApi(path, init, "*/*");
  if (!response.ok) throw apiError(response, await readJson(response));
  return response.blob();
}

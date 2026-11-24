import { useCallback, useEffect, useRef } from "react";
import { apiFetch, apiFetchBlob, isAbortError, type ApiResult } from "./api";

type RequestOptions<T> = {
  init?: Omit<RequestInit, "signal">;
  onSuccess?: (result: T) => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
};

// Use one scope for each independently replaceable request, such as a read and a write.
export function useRequestScope() {
  const mounted = useRef(false);
  const pending = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    const controller = pending.current;
    pending.current = null;
    controller?.abort();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);

  const run = useCallback(function run<T>(request: (signal: AbortSignal) => Promise<T>, options: RequestOptions<T>) {
    if (!mounted.current) return;
    cancel();
    const controller = new AbortController();
    pending.current = controller;
    const isCurrent = () => pending.current === controller;

    async function execute() {
      try {
        const result = await request(controller.signal);
        if (isCurrent()) options.onSuccess?.(result);
      } catch (error) {
        if (isCurrent() && !isAbortError(error)) options.onError(error);
      } finally {
        if (isCurrent()) {
          pending.current = null;
          options.onSettled?.();
        }
      }
    }

    // The event handler returns no promise. Surface unexpected errors in its callbacks.
    void execute().catch((error) => {
      if (!isAbortError(error)) reportError(error);
    });
  }, [cancel]);

  const json = useCallback(function json<T>(path: `/${string}`, options: RequestOptions<ApiResult<T>>) {
    run((signal) => apiFetch<T>(path, { ...options.init, signal }), options);
  }, [run]);

  const blob = useCallback((path: `/${string}`, options: RequestOptions<Blob>) => {
    run((signal) => apiFetchBlob(path, { ...options.init, signal }), options);
  }, [run]);

  return { json, blob, run, cancel };
}

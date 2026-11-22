"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/api";
import { getAccessToken } from "../../lib/session";
import { connectSocket } from "../../lib/socket";
import { endSession, rolePages, type Role, type User } from "./session";

export function RoleHome({ role }: { role: Role }) {
  const router = useRouter();
  const [user, setUser] = useState<User>();
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const token = getAccessToken();
    if (!token) {
      router.replace("/login");
      return;
    }
    let socket: ReturnType<typeof connectSocket> | undefined;

    function onDisconnect(reason: string) {
      if (reason === "io server disconnect") void loadSession();
    }

    function onConnectError(failure: Error & { data?: { code?: string } }) {
      if (failure.data?.code === "UNAUTHENTICATED") void loadSession();
    }

    async function loadSession() {
      if (controller.signal.aborted || getAccessToken() !== token) return;
      try {
        const { data } = await apiFetch<User>("/users/me", { signal: controller.signal });
        if (controller.signal.aborted || getAccessToken() !== token) return;
        if (data.role !== role) {
          router.replace(rolePages[data.role].path);
          return;
        }
        setError("");
        setUser(data);
        if (!socket) {
          socket = connectSocket();
          socket.on("connect", loadSession);
          socket.on("connect_error", onConnectError);
          socket.on("disconnect", onDisconnect);
        }
      } catch (failure) {
        if (controller.signal.aborted || getAccessToken() !== token) return;
        if (failure instanceof ApiError && failure.status === 401) {
          setUser(undefined);
          endSession();
          router.replace("/login");
          return;
        }
        setError("Your session could not be checked. Reload the page to try again.");
      }
    }

    void loadSession();
    window.addEventListener("focus", loadSession);
    return () => {
      controller.abort();
      window.removeEventListener("focus", loadSession);
      socket?.off("connect", loadSession);
      socket?.off("connect_error", onConnectError);
      socket?.off("disconnect", onDisconnect);
    };
  }, [role, router]);

  return (
    <main>
      <h1>{rolePages[role].title}</h1>
      {error ? <p role="alert">{error}</p> : <p>{user ? `Signed in as ${user.displayName}.` : "Checking your session…"}</p>}
      <Link href="/logout">Sign out</Link>
    </main>
  );
}

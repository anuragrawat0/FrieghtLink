"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../../lib/api";
import { getAccessToken } from "../../lib/session";
import { connectSocket } from "../../lib/socket";
import { useRequestScope } from "../../lib/use-request-scope";
import { endSession, rolePages, type Role, type User } from "./session";

export function RoleHome({ role, children }: { role: Role; children?: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User>();
  const [error, setError] = useState("");
  const { json, cancel } = useRequestScope();

  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      router.replace("/login");
      return;
    }
    let socket: ReturnType<typeof connectSocket> | undefined;

    function onDisconnect(reason: string) {
      if (reason === "io server disconnect") refreshSession();
    }

    function onConnectError(failure: Error & { data?: { code?: string } }) {
      if (failure.data?.code === "UNAUTHENTICATED") refreshSession();
    }

    function refreshSession() {
      if (getAccessToken() !== token) return;
      json<User>("/users/me", {
        onSuccess: ({ data }) => {
          if (getAccessToken() !== token) return;
          if (data.role !== role) {
            router.replace(rolePages[data.role].path);
            return;
          }
          setError("");
          setUser(data);
          if (!socket) {
            socket = connectSocket();
            socket.on("connect", refreshSession);
            socket.on("connect_error", onConnectError);
            socket.on("disconnect", onDisconnect);
          }
        },
        onError: (failure) => {
          if (getAccessToken() !== token) return;
          if (failure instanceof ApiError && failure.status === 401) {
            setUser(undefined);
            endSession();
            router.replace("/login");
            return;
          }
          setError("Your session could not be checked. Reload the page to try again.");
        },
      });
    }

    refreshSession();
    window.addEventListener("focus", refreshSession);
    return () => {
      window.removeEventListener("focus", refreshSession);
      socket?.off("connect", refreshSession);
      socket?.off("connect_error", onConnectError);
      socket?.off("disconnect", onDisconnect);
      cancel();
    };
  }, [role, router, json, cancel]);

  if (!user && !error) {
    return <main><p role="status">Checking your session…</p></main>;
  }

  return (
    <main>
      <header>
        <nav aria-label="Account"><Link href={rolePages[role].path}>{rolePages[role].title} home</Link>{" · "}<Link href="/logout">Sign out</Link></nav>
        {user && <p>Signed in as {user.displayName}.</p>}
      </header>
      {error && <p role="alert">{error}</p>}
      {user?.role === role && children}
    </main>
  );
}

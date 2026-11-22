"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch, ApiError } from "../../lib/api";
import { setAccessToken } from "../../lib/session";
import { disconnectSocket } from "../../lib/socket";
import { rolePages, type Auth } from "./session";

export function AuthPage({ mode }: { mode: "register" | "login" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const register = mode === "register";
  const title = register ? "Create an account" : "Sign in";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const fields = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    const credentials = { email: fields.get("email"), password: fields.get("password") };
    const body = register
      ? { ...credentials, displayName: fields.get("displayName"), role: fields.get("role") }
      : credentials;

    try {
      const { data } = await apiFetch<Auth>(`/auth/${mode}`, { method: "POST", body: JSON.stringify(body) });
      disconnectSocket();
      setAccessToken(data.accessToken);
      router.replace(rolePages[data.user.role].path);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "FreightLink could not be reached. Try again.");
      setPending(false);
    }
  }

  return (
    <main>
      <h1>{title}</h1>
      <form method="post" onSubmit={submit} aria-busy={pending}>
        {register && (
          <p><label>Display name <input name="displayName" autoComplete="name" required /></label></p>
        )}
        <p><label>Email <input name="email" type="email" autoComplete="username" required /></label></p>
        <p>
          <label>
            Password{" "}
            <input name="password" type="password" autoComplete={register ? "new-password" : "current-password"}
              aria-describedby={register ? "password-hint" : undefined} required />
          </label>
          {register && <small id="password-hint"> Use 12–128 characters.</small>}
        </p>
        {register && (
          <p>
            <label>
              Account type{" "}
              <select name="role" required defaultValue="">
                <option value="" disabled>Select a role</option>
                <option value="SHIPPER">Shipper</option>
                <option value="CARRIER">Carrier</option>
              </select>
            </label>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={pending}>{pending ? "Please wait…" : title}</button>
      </form>
      <p>{register ? <Link href="/login">Sign in</Link> : <Link href="/register">Create an account</Link>}</p>
    </main>
  );
}

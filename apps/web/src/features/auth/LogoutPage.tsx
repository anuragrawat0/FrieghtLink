"use client";

import { useRouter } from "next/navigation";
import { endSession } from "./session";

export function LogoutPage() {
  const router = useRouter();

  function signOut() {
    endSession();
    router.replace("/login");
  }

  return (
    <main>
      <h1>Sign out</h1>
      <button type="button" onClick={signOut}>Sign out</button>
    </main>
  );
}

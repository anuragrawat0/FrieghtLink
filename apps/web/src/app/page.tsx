import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>FreightLink</h1>
      <p><Link href="/login">Sign in</Link></p>
      <p><Link href="/register">Create an account</Link></p>
    </main>
  );
}

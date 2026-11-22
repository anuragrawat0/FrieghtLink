"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRequestScope } from "../../lib/use-request-scope";
import type { AdminCarrier, CarrierProfile } from "./types";
import { VerificationBadge } from "./VerificationBadge";

const pageSize = 20;

export function PendingCarriersPage() {
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AdminCarrier[]>();
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const { json, cancel } = useRequestScope();

  useEffect(() => {
    json<AdminCarrier[]>(`/admin/carriers?status=PENDING&limit=${pageSize}&offset=${offset}`, {
      onSuccess: ({ data, meta }) => {
        setRows(data);
        setHasMore(meta?.hasMore ?? false);
      },
      onError: (error) => setError(error instanceof Error ? error.message : "Could not load pending reviews."),
    });
    return cancel;
  }, [offset, json, cancel]);

  function goToPage(nextOffset: number) {
    setRows(undefined);
    setError("");
    setOffset(nextOffset);
  }

  return <section>
    <h1>Pending carrier reviews</h1>
    {error && <p role="alert">{error}</p>}
    {rows ? (rows.length ? <ul>{rows.map(({ carrierProfile, user }) => <li key={carrierProfile.id}>
      <Link href={`/admin/carriers/${carrierProfile.id}`}>{user.displayName}</Link> — {carrierProfile.motorCarrierLicense}
    </li>)}</ul> : <p>No pending reviews.</p>) : !error && <p role="status">Loading reviews…</p>}
    {offset > 0 && <button onClick={() => goToPage(offset - pageSize)}>Previous</button>}{" "}
    {rows && hasMore && <button onClick={() => goToPage(offset + pageSize)}>Next</button>}
  </section>;
}

export function CarrierReviewPage({ id }: { id: string }) {
  const [carrier, setCarrier] = useState<AdminCarrier>();
  const [decision, setDecision] = useState<"APPROVED" | "REJECTED">("APPROVED");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { json: read, cancel } = useRequestScope();
  const { json: write, blob } = useRequestScope();

  useEffect(() => {
    read<AdminCarrier>(`/admin/carriers/${id}`, {
      onSuccess: ({ data }) => setCarrier(data),
      onError: (error) => setError(error instanceof Error ? error.message : "Could not load the carrier profile."),
    });
    return cancel;
  }, [id, read, cancel]);

  const actionHandlers = {
    onError: (error: unknown) => setError(error instanceof Error ? error.message : "The request could not be completed."),
    onSettled: () => setBusy(false),
  };

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!carrier) return;
    const note = String(new FormData(event.currentTarget).get("reviewNote")).trim();
    if (decision === "REJECTED" && !note) { setError("Enter a rejection note."); return; }
    setBusy(true);
    setError("");
    write<CarrierProfile>(`/admin/carriers/${id}/review`, {
      init: {
        method: "POST",
        body: JSON.stringify({ decision, expectedRevision: carrier.carrierProfile.verificationRevision, reviewNote: note || undefined }),
      },
      onSuccess: ({ data }) => setCarrier({ ...carrier, carrierProfile: data }),
      ...actionHandlers,
    });
  }

  function download() {
    setBusy(true);
    setError("");
    blob(`/admin/carriers/${id}/insurance`, {
      onSuccess: (certificate) => {
        const url = URL.createObjectURL(certificate);
        const link = document.createElement("a");
        const extensions: Record<string, string> = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png" };
        link.href = url;
        link.download = `insurance${extensions[certificate.type] ?? ""}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      ...actionHandlers,
    });
  }

  const profile = carrier?.carrierProfile;
  return <section>
    <h1>Carrier review</h1>
    <Link href="/admin/carriers">Pending reviews</Link>
    {error && <p role="alert">{error}</p>}
    {!carrier && !error && <p role="status">Loading carrier…</p>}
    {carrier && profile && <>
      <h2>{carrier.user.displayName}</h2>
      <p><VerificationBadge status={profile.verificationStatus} /></p>
      <dl>
        <dt>Email</dt><dd>{carrier.user.email}</dd>
        <dt>Motor carrier license</dt><dd>{profile.motorCarrierLicense ?? "—"}</dd>
        <dt>Safety rating</dt><dd>{profile.safetyRating?.replaceAll("_", " ") ?? "—"}</dd>
        {profile.reviewNote && <><dt>Reviewer note</dt><dd>{profile.reviewNote}</dd></>}
      </dl>
      {profile.insurance && <button type="button" disabled={busy} onClick={download}>Download certificate</button>}
      {profile.verificationStatus === "PENDING" && <form onSubmit={review}>
        <fieldset disabled={busy}>
          <legend>Verification decision</legend>
          <p><label>Decision <select value={decision} onChange={(event) => setDecision(event.target.value === "REJECTED" ? "REJECTED" : "APPROVED")}>
            <option value="APPROVED">Approve</option><option value="REJECTED">Reject</option>
          </select></label></p>
          <p><label>Review note <textarea name="reviewNote" maxLength={500} required={decision === "REJECTED"} /></label></p>
          <button>{decision === "APPROVED" ? "Approve carrier" : "Reject carrier"}</button>
        </fieldset>
      </form>}
    </>}
  </section>;
}

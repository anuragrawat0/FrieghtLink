"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { connectSocket } from "../../lib/socket";
import { useRequestScope } from "../../lib/use-request-scope";
import { safetyRatings, type CarrierProfile } from "./types";
import { VerificationBadge } from "./VerificationBadge";

export function CarrierProfilePage() {
  const [profile, setProfile] = useState<CarrierProfile>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { json: read, cancel } = useRequestScope();
  const { json: write } = useRequestScope();

  const refresh = useCallback(() => {
    read<CarrierProfile>("/carriers/me", {
      onSuccess: ({ data }) => setProfile(data),
      onError: (error) => setError(error instanceof Error ? error.message : "Could not load your profile."),
    });
  }, [read]);

  useEffect(() => {
    const socket = connectSocket();
    socket.on("connect", refresh);
    socket.on("carrier:verificationChanged", refresh);
    refresh();
    return () => {
      socket.off("connect", refresh);
      socket.off("carrier:verificationChanged", refresh);
      cancel();
    };
  }, [refresh, cancel]);

  function changeProfile(path: `/${string}`, init: RequestInit) {
    setBusy(true);
    setError("");
    write(path, {
      init,
      onSuccess: refresh,
      onError: (error) => setError(error instanceof Error ? error.message : "Could not update your profile."),
      onSettled: () => setBusy(false),
    });
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    changeProfile("/carriers/me", {
      method: "PATCH",
      body: JSON.stringify({ motorCarrierLicense: form.get("motorCarrierLicense"), safetyRating: form.get("safetyRating") }),
    });
  }

  function uploadInsurance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    changeProfile("/carriers/me/insurance", { method: "PUT", body: form });
  }

  const editable = profile?.verificationStatus === "DRAFT" || profile?.verificationStatus === "REJECTED";
  return <section>
    <h1>Carrier verification</h1>
    <Link href="/carrier/loads">Browse loads</Link>{" · "}<Link href="/carrier/bids">My bids</Link>{" · "}
    <Link href="/carrier/shipments">My shipments</Link>
    {error && <p role="alert">{error}</p>}
    {!profile && !error && <p role="status">Loading profile…</p>}
    {profile && <>
      <p><VerificationBadge status={profile.verificationStatus} /></p>
      {profile.reviewNote && <p>Reviewer note — {profile.reviewNote}</p>}
      <form onSubmit={saveProfile} key={`${profile.motorCarrierLicense}:${profile.safetyRating}`}>
        <fieldset disabled={busy || !editable}>
          <legend>Carrier profile</legend>
          <p><label>Motor carrier license <input name="motorCarrierLicense" maxLength={40} defaultValue={profile.motorCarrierLicense ?? ""} required /></label></p>
          <p><label>Safety rating <select name="safetyRating" defaultValue={profile.safetyRating ?? ""} required>
            <option value="">Select a rating</option>
            {safetyRatings.map((rating) => <option key={rating} value={rating}>{rating.replaceAll("_", " ")}</option>)}
          </select></label></p>
          {editable && <button>Save profile</button>}
        </fieldset>
      </form>
      <p>{profile.insurance ? `Insurance uploaded ${new Date(profile.insurance.uploadedAt).toLocaleString()}.` : "No insurance certificate uploaded."}</p>
      {editable && <>
        <form onSubmit={uploadInsurance}>
          <label>Insurance certificate <input type="file" name="file" accept="application/pdf,image/jpeg,image/png" required disabled={busy} /></label>
          <button disabled={busy}>Upload certificate</button>
        </form>
        <p><button type="button" disabled={busy || !profile.motorCarrierLicense || !profile.safetyRating || !profile.insurance}
          onClick={() => changeProfile("/carriers/me/verification", { method: "POST" })}>Submit for review</button></p>
      </>}
    </>}
  </section>;
}

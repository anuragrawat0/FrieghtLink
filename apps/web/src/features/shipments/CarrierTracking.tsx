"use client";

import { useState, type FormEvent } from "react";
import { useRequestScope } from "../../lib/use-request-scope";
import { checkpointLabels, type Checkpoint, type ShipmentDetail, type TrackingKind } from "./types";

export function CarrierTracking({ shipment, checkpoints, onChange }: {
  shipment: ShipmentDetail; checkpoints: Checkpoint[]; onChange: () => void;
}) {
  const { json } = useRequestScope();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const last = checkpoints.at(-1)?.kind;
  const gpsCount = checkpoints.filter((checkpoint) => checkpoint.kind === "GPS").length;
  const { id, load } = shipment;

  function submit(path: `/shipments/${string}`, body: string | FormData) {
    setBusy(true);
    setError("");
    json(path, {
      init: { method: "POST", body },
      onSuccess: onChange,
      onError: (failure) => {
        setError(failure instanceof Error ? failure.message : "Could not record the shipment update.");
        onChange();
      },
      onSettled: () => setBusy(false),
    });
  }

  function record(kind: TrackingKind) {
    const step = Math.min(1, (gpsCount + 1) / 4);
    const coordinates = kind === "GPS" ? {
      latitude: load.pickupLat + (load.deliveryLat - load.pickupLat) * step,
      longitude: load.pickupLng + (load.deliveryLng - load.pickupLng) * step,
    } : {};
    submit(`/shipments/${id}/checkpoints`, JSON.stringify({
      clientEventId: crypto.randomUUID(), kind, occurredAt: new Date().toISOString(), ...coordinates,
    }));
  }

  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = new FormData(event.currentTarget);
    body.set("clientEventId", crypto.randomUUID());
    submit(`/shipments/${id}/pod`, body);
  }

  const inTransit = last === "PICKED_UP" || last === "GPS";
  if (shipment.status === "DELIVERED") return null;

  return <section>
    <h2>Record tracking</h2>
    {error && <p role="alert">{error}</p>}
    {last === "ASSIGNED" && <button disabled={busy} onClick={() => record("PICKUP_ARRIVAL")}>{checkpointLabels.PICKUP_ARRIVAL}</button>}
    {last === "PICKUP_ARRIVAL" && <button disabled={busy} onClick={() => record("PICKED_UP")}>{checkpointLabels.PICKED_UP}</button>}
    {inTransit && <>
      <button disabled={busy || gpsCount >= 4} onClick={() => record("GPS")}>Simulate GPS</button>{" "}
      <button disabled={busy} onClick={() => record("DELIVERY_ARRIVAL")}>{checkpointLabels.DELIVERY_ARRIVAL}</button>
    </>}
    {last === "DELIVERY_ARRIVAL" && <form onSubmit={upload}>
      <label>Proof of delivery photo <input type="file" name="file" accept="image/jpeg,image/png" required /></label>{" "}
      <button disabled={busy}>Upload proof of delivery</button>
    </form>}
  </section>;
}

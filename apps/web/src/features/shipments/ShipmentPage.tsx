"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { LatLngTuple } from "leaflet";
import { apiFetch } from "../../lib/api";
import { connectSocket } from "../../lib/socket";
import { useRequestScope } from "../../lib/use-request-scope";
import { formatRate } from "../bids/types";
import { CarrierTracking } from "./CarrierTracking";
import { checkpointLabels, shipmentStatus, type Checkpoint, type InvoiceDetail, type ShipmentDetail, type ShipmentRole } from "./types";

const ShipmentMap = dynamic(() => import("./ShipmentMap"), { ssr: false, loading: () => <p role="status">Loading map…</p> });

type View = { shipment: ShipmentDetail; checkpoints: Checkpoint[]; invoice: InvoiceDetail | null };
const pageSize = 100;

async function readCheckpoints(shipmentId: string, signal: AbortSignal) {
  const checkpoints: Checkpoint[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, meta } = await apiFetch<Checkpoint[]>(`/shipments/${shipmentId}/checkpoints?limit=${pageSize}&offset=${offset}`, { signal });
    checkpoints.push(...data);
    if (!meta?.hasMore) return checkpoints;
  }
}

function displayTime(time: string) {
  return new Date(time).toLocaleString();
}

export function ShipmentPage({ shipmentId, role }: { shipmentId: string; role: ShipmentRole }) {
  const [view, setView] = useState<View>();
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const { run, cancel } = useRequestScope();
  const { blob } = useRequestScope();

  const refresh = useCallback(() => {
    run(async (signal) => {
      const { data: shipment } = await apiFetch<ShipmentDetail>(`/shipments/${shipmentId}`, { signal });
      const [checkpoints, invoice] = await Promise.all([
        readCheckpoints(shipmentId, signal),
        shipment.invoiceId ? apiFetch<InvoiceDetail>(`/invoices/${shipment.invoiceId}`, { signal }) : null,
      ]);
      return { shipment, checkpoints, invoice: invoice?.data ?? null };
    }, {
      onSuccess: (next) => { setView(next); setError(""); },
      onError: (failure) => setError(failure instanceof Error ? failure.message : "Could not load the shipment."),
    });
  }, [run, shipmentId]);

  useEffect(() => {
    const socket = connectSocket();
    const room = { shipmentId };
    let active = true;
    let joined = false;
    let fallback: ReturnType<typeof setTimeout> | undefined;

    function subscribe() {
      clearTimeout(fallback);
      socket.timeout(5_000).emit("shipment:subscribe", room, (error: Error | null, ack?: { ok: boolean }) => {
        if (!active) return;
        joined = !error && ack?.ok === true;
        refresh();
      });
    }
    function onUpdate(event: { shipmentId: string }) {
      if (joined && event.shipmentId === shipmentId.toLowerCase()) refresh();
    }
    function onDisconnect() { joined = false; }

    socket.on("connect", subscribe).on("disconnect", onDisconnect).on("shipment:updated", onUpdate).on("invoice:updated", onUpdate);
    if (socket.connected) subscribe();
    else fallback = setTimeout(refresh, 5_000);

    return () => {
      active = false;
      clearTimeout(fallback);
      socket.off("connect", subscribe).off("disconnect", onDisconnect).off("shipment:updated", onUpdate).off("invoice:updated", onUpdate);
      if (socket.connected) socket.emit("shipment:unsubscribe", room, () => {});
      cancel();
    };
  }, [cancel, refresh, shipmentId]);

  function downloadProof() {
    setDownloadError("");
    blob(`/shipments/${shipmentId}/pod/file`, {
      onSuccess: (file) => {
        const url = URL.createObjectURL(file);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.type === "image/png" ? "proof-of-delivery.png" : "proof-of-delivery.jpg";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      },
      onError: (failure) => setDownloadError(failure instanceof Error ? failure.message : "Could not download the photo."),
    });
  }

  if (!view) return <><Link href={`/${role}/shipments`}>My shipments</Link>
    {error ? <p role="alert">{error}</p> : <p role="status">Loading shipment…</p>}</>;

  const { shipment, checkpoints, invoice } = view;
  const { load } = shipment;
  const pickup: LatLngTuple = [load.pickupLat, load.pickupLng];
  const delivery: LatLngTuple = [load.deliveryLat, load.deliveryLng];
  const trail = checkpoints.flatMap(({ latitude, longitude }): LatLngTuple[] =>
    latitude === null || longitude === null ? [] : [[latitude, longitude]]);
  const last = checkpoints.at(-1)?.kind;
  const latest = last === "DELIVERY_ARRIVAL" || last === "DELIVERED" ? delivery : trail.at(-1) ?? pickup;

  return <>
    <nav aria-label="Shipment"><Link href={`/${role}/shipments`}>My shipments</Link>{" · "}
      <Link href={`/${role}/loads/${load.id}`}>View load</Link></nav>
    <h1>{load.description}</h1>
    <p>{load.pickupCity}, {load.pickupRegion} to {load.deliveryCity}, {load.deliveryRegion}</p>
    <dl>
      <dt>Status</dt><dd>{shipmentStatus[shipment.status]}</dd>
      <dt>ETA</dt><dd>{shipment.currentEtaAt ? <time dateTime={shipment.currentEtaAt}>{displayTime(shipment.currentEtaAt)}</time> : "—"}</dd>
    </dl>
    {error && <p role="alert">{error}</p>}
    <ShipmentMap pickup={pickup} delivery={delivery} trail={trail} latest={latest} />
    {role === "carrier" && <CarrierTracking shipment={shipment} checkpoints={checkpoints} onChange={refresh} />}
    <section>
      <h2>Checkpoint timeline</h2>
      <ol>{checkpoints.map((checkpoint) => <li key={checkpoint.id}>
        {checkpointLabels[checkpoint.kind]}{" · "}<time dateTime={checkpoint.occurredAt}>{displayTime(checkpoint.occurredAt)}</time>
        {checkpoint.latitude !== null && checkpoint.longitude !== null && <> ({checkpoint.latitude.toFixed(4)}, {checkpoint.longitude.toFixed(4)})</>}
      </li>)}</ol>
    </section>
    {shipment.proofOfDelivery && <button type="button" onClick={downloadProof}>Download proof of delivery</button>}
    {downloadError && <p role="alert">{downloadError}</p>}
    {invoice && <section>
      <h2>Invoice</h2>
      <p>Total {formatRate(invoice.totalCents)}</p>
      <ul>{invoice.detentionCharges.map((charge) => <li key={charge.stop}>
        {charge.stop === "PICKUP" ? "Pickup" : "Delivery"} detention · {formatRate(charge.amountCents)}
        {" · "}{charge.billableSeconds} billable seconds
      </li>)}</ul>
    </section>}
  </>;
}

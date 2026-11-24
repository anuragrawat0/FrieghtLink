"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import { connectSocket } from "../../lib/socket";
import { useRequestScope } from "../../lib/use-request-scope";
import { AssignmentSummary } from "../bids/AssignmentSummary";
import { LoadBids } from "../bids/LoadBids";
import { LoadForm, type Load, type LoadInput } from "./LoadForm";

type LoadRole = "shipper" | "carrier";
const pageSize = 20;

export function LoadsPage({ role }: { role: LoadRole }) {
  const router = useRouter();
  const [offset, setOffset] = useState(0);
  const [loads, setLoads] = useState<Load[]>();
  const [hasMore, setHasMore] = useState(false);
  const [listError, setListError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [unpublishedDraft, setUnpublishedDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { json: read, cancel } = useRequestScope();
  const { json: write } = useRequestScope();

  useEffect(() => {
    const socket = connectSocket();
    function refresh() {
      const status = role === "carrier" ? "&status=OPEN" : "";
      read<Load[]>(`/loads?limit=${pageSize}&offset=${offset}${status}`, {
        onSuccess: ({ data, meta }) => {
          setLoads(data);
          setHasMore(meta?.hasMore ?? false);
          setListError("");
        },
        onError: (error) => {
          setLoads(undefined);
          setListError(error instanceof ApiError && error.code === "CARRIER_NOT_APPROVED"
            ? "Your carrier profile must be approved before you can browse loads."
            : error instanceof Error ? error.message : "Could not load the list.");
        },
      });
    }
    socket.on("connect", refresh);
    socket.on("bid:updated", refresh);
    socket.on("load:assigned", refresh);
    if (role === "carrier") socket.on("carrier:verificationChanged", refresh);
    refresh();
    return () => {
      socket.off("connect", refresh);
      socket.off("bid:updated", refresh);
      socket.off("load:assigned", refresh);
      socket.off("carrier:verificationChanged", refresh);
      cancel();
    };
  }, [offset, role, read, cancel]);

  function create(input: LoadInput, publish: boolean) {
    setBusy(true);
    setSaveError("");
    setUnpublishedDraft(undefined);
    write<Load>("/loads", {
      init: { method: "POST", body: JSON.stringify(input) },
      onSuccess: ({ data }) => {
        if (!publish) {
          router.push(`/shipper/loads/${data.id}`);
          return;
        }
        write<Load>(`/loads/${data.id}/publish`, {
          init: { method: "POST" },
          onSuccess: () => router.push(`/shipper/loads/${data.id}`),
          onError: (error) => {
            setUnpublishedDraft(data.id);
            setSaveError(error instanceof Error ? error.message : "Could not publish the saved draft.");
          },
          onSettled: () => setBusy(false),
        });
      },
      onError: (error) => setSaveError(error instanceof Error ? error.message : "Could not create the load."),
      onSettled: () => setBusy(false),
    });
  }

  return <section>
    <h1>{role === "shipper" ? "Your loads" : "Open loads"}</h1>
    {listError && <p role="alert">{listError}</p>}
    {loads ? (loads.length ? <ul>{loads.map((load) => <li key={load.id}>
      <Link href={`/${role}/loads/${load.id}`}>{load.description}</Link>{" "}
      — {load.pickupCity}, {load.pickupRegion} to {load.deliveryCity}, {load.deliveryRegion} ({load.status})
    </li>)}</ul> : <p>{role === "shipper" ? "No loads on this page." : "No open loads on this page."}</p>) : !listError && <p role="status">Loading loads…</p>}
    {offset > 0 && <button onClick={() => { setLoads(undefined); setOffset(offset - pageSize); }}>Previous</button>}{" "}
    {loads && hasMore && <button onClick={() => { setLoads(undefined); setOffset(offset + pageSize); }}>Next</button>}
    {role === "shipper" && <>
      {saveError && <p role="alert">{saveError}</p>}
      {unpublishedDraft && <p><Link href={`/shipper/loads/${unpublishedDraft}`}>Open the saved draft</Link></p>}
      <LoadForm busy={busy} onSave={create} />
    </>}
  </section>;
}

export function LoadDetailPage({ role, id }: { role: LoadRole; id: string }) {
  const [load, setLoad] = useState<Load>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { json: read, cancel } = useRequestScope();
  const { json: write } = useRequestScope();

  const refresh = useCallback(() => {
    read<Load>(`/loads/${id}`, {
      onSuccess: ({ data }) => {
        setLoad(data);
        setError("");
      },
      onError: (error) => {
        setLoad(undefined);
        setError(error instanceof Error ? error.message : "Could not load the details.");
      },
    });
  }, [id, read]);

  useEffect(() => {
    const socket = connectSocket();
    function onBidUpdated(event: { loadId: string }) {
      if (event.loadId === id) refresh();
    }
    socket.on("connect", refresh);
    socket.on("bid:updated", onBidUpdated);
    socket.on("load:assigned", onBidUpdated);
    if (role === "carrier") socket.on("carrier:verificationChanged", refresh);
    refresh();
    return () => {
      socket.off("connect", refresh);
      socket.off("bid:updated", onBidUpdated);
      socket.off("load:assigned", onBidUpdated);
      socket.off("carrier:verificationChanged", refresh);
      cancel();
    };
  }, [id, role, refresh, cancel]);

  function update(path: `/${string}`, init: RequestInit) {
    setBusy(true);
    setError("");
    write<Load>(path, {
      init,
      onSuccess: ({ data }) => {
        cancel();
        setLoad(data);
        setError("");
      },
      onError: (error) => setError(error instanceof Error ? error.message : "Could not update the load."),
      onSettled: () => setBusy(false),
    });
  }

  return <section>
    <h1>Load details</h1>
    <Link href={`/${role}/loads`}>{role === "shipper" ? "Your loads" : "Open loads"}</Link>
    {error && <p role="alert">{error}</p>}
    {!load && !error && <p role="status">Loading load…</p>}
    {load && <>
      <p>{load.description} ({load.status})</p>
      <dl>
        <dt>Pickup</dt><dd>{load.pickupCity}, {load.pickupRegion} ({load.pickupLat}, {load.pickupLng})</dd>
        <dt>Ready at</dt><dd>{new Date(load.pickupReadyAt).toLocaleString()}</dd>
        <dt>Delivery</dt><dd>{load.deliveryCity}, {load.deliveryRegion} ({load.deliveryLat}, {load.deliveryLng})</dd>
        <dt>Deliver by</dt><dd>{new Date(load.deliveryBy).toLocaleString()}</dd>
      </dl>
      {load.status === "ASSIGNED" && <AssignmentSummary key={`assignment-${load.id}`} loadId={load.id} role={role} />}
      {role === "shipper" && <>
        {load.status === "DRAFT" && <>
          <LoadForm key={load.updatedAt} load={load} busy={busy} onSave={(input) => update(`/loads/${id}`, { method: "PATCH", body: JSON.stringify(input) })} />
          <button type="button" disabled={busy} onClick={() => update(`/loads/${id}/publish`, { method: "POST" })}>Publish load</button>{" "}
        </>}
        {(load.status === "DRAFT" || load.status === "OPEN") && <button type="button" disabled={busy}
          onClick={() => update(`/loads/${id}/cancel`, { method: "POST" })}>Cancel load</button>}
      </>}
      <LoadBids key={load.id} load={load} role={role} onChange={refresh} />
    </>}
  </section>;
}

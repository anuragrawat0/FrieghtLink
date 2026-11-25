"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { connectSocket } from "../../lib/socket";
import { useRequestScope } from "../../lib/use-request-scope";
import { formatRate } from "../bids/types";
import { shipmentStatus, type Shipment, type ShipmentRole } from "./types";

const pageSize = 20;

export function MyShipmentsPage({ role }: { role: ShipmentRole }) {
  const [page, setPage] = useState<{ rows: Shipment[]; hasMore: boolean }>();
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const { json, cancel } = useRequestScope();

  const refresh = useCallback(() => {
    json<Shipment[]>(`/shipments?limit=${pageSize}&offset=${offset}`, {
      onSuccess: ({ data, meta }) => { setPage({ rows: data, hasMore: meta?.hasMore ?? false }); setError(""); },
      onError: (failure) => setError(failure instanceof Error ? failure.message : "Could not load shipments."),
    });
  }, [json, offset]);

  useEffect(() => {
    const socket = connectSocket();
    socket.on("connect", refresh).on("load:assigned", refresh).on("invoice:updated", refresh);
    refresh();
    return () => {
      socket.off("connect", refresh).off("load:assigned", refresh).off("invoice:updated", refresh);
      cancel();
    };
  }, [cancel, refresh]);

  function goTo(nextOffset: number) {
    setPage(undefined);
    setOffset(nextOffset);
  }

  return <>
    <h1>My shipments</h1>
    {error && <p role="alert">{error}</p>}
    {!page && !error && <p role="status">Loading shipments…</p>}
    {page && (page.rows.length ? <ul>{page.rows.map((row) => <li key={row.id}>
      <Link href={`/${role}/shipments/${row.id}`}>Shipment {row.id}</Link>
      {" · "}{shipmentStatus[row.status]}{" · "}{formatRate(row.acceptedRateCents)}
    </li>)}</ul> : <p>No shipments on this page.</p>)}
    {offset > 0 && <button onClick={() => goTo(offset - pageSize)}>Previous shipments</button>}{" "}
    {page?.hasMore && <button onClick={() => goTo(offset + pageSize)}>Next shipments</button>}
  </>;
}

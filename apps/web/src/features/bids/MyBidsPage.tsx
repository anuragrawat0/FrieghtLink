"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { apiFetch } from "../../lib/api";
import { useRequestScope } from "../../lib/use-request-scope";
import type { Load } from "../loads/LoadForm";
import { formatRate, type Bid, type BidStatus } from "./types";
import { useBidUpdates } from "./use-bid-updates";

const pageSize = 20;
type BidRow = { bid: Bid; description: string };

export function MyBidsPage() {
  const [status, setStatus] = useState<BidStatus | "">("");
  const [rows, setRows] = useState<BidRow[]>();
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const { run, cancel } = useRequestScope();

  const refresh = useCallback(() => {
    const filter = status ? `&status=${status}` : "";
    run(async (signal) => {
      const { data, meta } = await apiFetch<Bid[]>(`/bids?limit=${pageSize}&offset=${offset}${filter}`, { signal });
      const rows = await Promise.all(data.map(async (bid) => {
        const { data: load } = await apiFetch<Load>(`/loads/${bid.loadId}`, { signal });
        return { bid, description: load.description };
      }));
      return { rows, hasMore: meta?.hasMore ?? false };
    }, {
      onSuccess: ({ rows, hasMore }) => {
        setRows(rows);
        setHasMore(hasMore);
        setError("");
      },
      onError: (error) => setError(error instanceof Error ? error.message : "Could not load your bids."),
    });
  }, [offset, run, status]);
  useBidUpdates(refresh, cancel);

  function goTo(nextOffset: number) {
    if (offset !== nextOffset) setRows(undefined);
    setOffset(nextOffset);
  }

  return <section>
    <h1>My bids</h1>
    <label>Status <select value={status} onChange={(event) => {
      setRows(undefined);
      setStatus(event.target.value as BidStatus | "");
      goTo(0);
    }}>
      <option value="">All bids</option>
      <option value="ACTIVE">Active</option>
      <option value="ACCEPTED">Accepted</option>
      <option value="CLOSED">Closed</option>
    </select></label>
    {error && <p role="alert">{error}</p>}
    {!rows && !error && <p role="status">Loading bids…</p>}
    {rows && (rows.length ? <ul>{rows.map(({ bid, description }) => <li key={bid.id}>
      <Link href={`/carrier/loads/${bid.loadId}`}>{description}</Link>{" "}
      · {bid.status} · {formatRate(bid.currentOffer.amountCents)}
    </li>)}</ul> : <p>No bids on this page.</p>)}
    {offset > 0 && <button onClick={() => goTo(offset - pageSize)}>Previous</button>}{" "}
    {rows && hasMore && <button onClick={() => goTo(offset + pageSize)}>Next</button>}
  </section>;
}

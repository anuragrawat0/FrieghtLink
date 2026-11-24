"use client";

import { useCallback, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { useRequestScope } from "../../lib/use-request-scope";
import type { Load } from "../loads/LoadForm";
import { formatRate, type Bid, type BidDetail, type BidRole } from "./types";
import { useBidUpdates } from "./use-bid-updates";

const pageSize = 20;

function OfferForm({ busy, onOffer, label }: { busy: boolean; onOffer: (amountCents: number) => void; label: string }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dollars = Number(new FormData(event.currentTarget).get("amount"));
    onOffer(Math.round(dollars * 100));
  }

  return <form onSubmit={submit}>
    <label>Offer (USD) <input name="amount" type="number" min="0.50" max="900000.00" step="0.01" required /></label>{" "}
    <button disabled={busy}>{label}</button>
  </form>;
}

export function LoadBids({ load, role, onChange }: { load: Load; role: BidRole; onChange: () => void }) {
  const [rows, setRows] = useState<Bid[]>();
  const [myBid, setMyBid] = useState<BidDetail | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const { run, cancel } = useRequestScope();
  const { json: write } = useRequestScope();
  const { id, status } = load;

  const refresh = useCallback(() => {
    run(async (signal) => {
      if (role === "shipper") {
        const { data, meta } = await apiFetch<Bid[]>(`/loads/${id}/bids?limit=${pageSize}&offset=${offset}`, { signal });
        return { data, hasMore: meta?.hasMore ?? false, detail: null };
      }
      const { data } = await apiFetch<Bid[]>(`/bids?loadId=${id}&limit=1`, { signal });
      const detail = data[0] ? (await apiFetch<BidDetail>(`/bids/${data[0].id}`, { signal })).data : null;
      return { data, hasMore: false, detail };
    }, {
      onSuccess: ({ data, hasMore, detail }) => {
        setRows(data);
        setHasMore(hasMore);
        setMyBid(detail);
        setReadError("");
      },
      onError: (error) => setReadError(error instanceof Error ? error.message : "Could not load bids."),
    });
  }, [id, offset, role, run]);
  useBidUpdates(refresh, cancel, id);

  function submit(path: `/${string}`, body: { amountCents?: number; expectedRevision?: number }) {
    setBusy(true);
    setActionError("");
    write(path, {
      init: { method: "POST", body: JSON.stringify(body) },
      onSuccess: () => { refresh(); onChange(); },
      onError: (error) => {
        setActionError(error instanceof Error ? error.message : "Could not update the bid.");
        refresh();
        onChange();
      },
      onSettled: () => setBusy(false),
    });
  }

  function counter(bid: Bid, amountCents: number) {
    submit(`/bids/${bid.id}/offers`, { amountCents, expectedRevision: bid.currentRevision });
  }

  function goTo(nextOffset: number) {
    setRows(undefined);
    setOffset(nextOffset);
  }

  return <section>
    <h2>{role === "shipper" ? "Bids" : "Your bid"}</h2>
    {readError && <p role="alert">{readError}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {!rows && !readError && <p role="status">Loading bids…</p>}
    {rows && role === "shipper" && <>
      {rows.length ? <ul>{rows.map((bid) => <li key={bid.id}>
        <h3>{bid.carrierDisplayName}</h3>
        <p>{bid.status} · Current offer {formatRate(bid.currentOffer.amountCents)} · Revision {bid.currentRevision}
          {bid.currentOffer.authorRole === "SHIPPER" ? " (your offer)" : " (carrier offer)"}</p>
        {bid.status === "ACTIVE" && status === "OPEN" && bid.currentOffer.authorRole === "CARRIER" &&
          <div key={bid.currentRevision}>
            <OfferForm busy={busy} label="Send counter-offer" onOffer={(amount) => counter(bid, amount)} />
            <button type="button" disabled={busy} onClick={() => submit(`/bids/${bid.id}/accept`, {
              expectedRevision: bid.currentRevision,
            })}>Accept bid</button>
          </div>}
      </li>)}</ul> : <p>No bids on this page.</p>}
      {offset > 0 && <button onClick={() => goTo(offset - pageSize)}>Previous bids</button>}{" "}
      {hasMore && <button onClick={() => goTo(offset + pageSize)}>Next bids</button>}
    </>}
    {rows && role === "carrier" && (myBid ? <>
      <p>{myBid.status} · Current offer {formatRate(myBid.currentOffer.amountCents)}</p>
      <h3>Offer history</h3>
      <ol>{myBid.offers.map((offer) => <li key={offer.revision}>
        {offer.authorRole === "CARRIER" ? "You" : "Shipper"} offered {formatRate(offer.amountCents)}
      </li>)}</ol>
      {myBid.status === "ACTIVE" && status === "OPEN" && myBid.currentOffer.authorRole === "SHIPPER" &&
        <OfferForm key={myBid.currentRevision} busy={busy} label="Send counter-offer" onOffer={(amount) => counter(myBid, amount)} />}
    </> : status === "OPEN"
      ? <OfferForm busy={busy} label="Place bid" onOffer={(amountCents) => submit(`/loads/${id}/bids`, { amountCents })} />
      : <p>You have no bid on this load.</p>)}
  </section>;
}

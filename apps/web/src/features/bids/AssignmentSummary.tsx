"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { apiFetch } from "../../lib/api";
import { useRequestScope } from "../../lib/use-request-scope";
import { formatRate, type Bid, type BidRole } from "./types";
import { useBidUpdates } from "./use-bid-updates";

type Shipment = { id: string; acceptedRateCents: number };
type Assignment = { carrier: string; shipment: Shipment };

export function AssignmentSummary({ loadId, role }: { loadId: string; role: BidRole }) {
  const [assignment, setAssignment] = useState<Assignment | null>();
  const [error, setError] = useState("");
  const { run, cancel } = useRequestScope();

  const refresh = useCallback(() => {
    run(async (signal) => {
      const bidPath = role === "shipper" ? `/loads/${loadId}/bids?` as const : `/bids?loadId=${loadId}&` as const;
      const { data: [bid] } = await apiFetch<Bid[]>(`${bidPath}status=ACCEPTED&limit=1`, { signal });
      if (!bid) return null;

      const { data: [shipment] } = await apiFetch<Shipment[]>(`/shipments?loadId=${loadId}&limit=1`, { signal });
      if (!shipment) throw new Error("The shipment for this assignment could not be found.");
      return { carrier: bid.carrierDisplayName, shipment };
    }, {
      onSuccess: (data) => { setAssignment(data); setError(""); },
      onError: (error) => setError(error instanceof Error ? error.message : "Could not load the assignment."),
    });
  }, [loadId, role, run]);
  useBidUpdates(refresh, cancel, loadId);

  if (error) return <p role="alert">{error}</p>;
  if (assignment === undefined) return <p role="status">Loading assignment…</p>;
  if (!assignment) return null;
  return <section>
    <h2>Assignment</h2>
    <dl>
      <dt>Assigned carrier</dt><dd>{assignment.carrier}</dd>
      <dt>Accepted rate</dt><dd>{formatRate(assignment.shipment.acceptedRateCents)}</dd>
      <dt>Shipment ID</dt><dd>{assignment.shipment.id}</dd>
    </dl>
    <Link href={`/${role}/shipments/${assignment.shipment.id}`}>View shipment</Link>{" · "}
    <Link href={`/${role}/shipments`}>My shipments</Link>
  </section>;
}

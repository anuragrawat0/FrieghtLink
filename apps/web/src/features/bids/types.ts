export type BidStatus = "ACTIVE" | "ACCEPTED" | "CLOSED";
export type BidRole = "shipper" | "carrier";

export type Offer = {
  revision: number;
  authorUserId: string;
  authorRole: "SHIPPER" | "CARRIER";
  amountCents: number;
  createdAt: string;
};

export type Bid = {
  id: string;
  loadId: string;
  carrierProfileId: string;
  carrierDisplayName: string;
  status: BidStatus;
  currentRevision: number;
  currentOffer: Offer;
  createdAt: string;
  updatedAt: string;
};

export type BidDetail = Bid & { offers: Offer[] };

export function formatRate(amountCents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amountCents / 100);
}

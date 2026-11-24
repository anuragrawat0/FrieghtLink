import type { Load } from "../loads/LoadForm";

export type ShipmentRole = "shipper" | "carrier";
export type Shipment = {
  id: string;
  loadId: string;
  acceptedRateCents: number;
  status: "ASSIGNED" | "IN_TRANSIT" | "DELIVERED";
  assignedAt: string;
  currentEtaAt: string | null;
};

export type ShipmentDetail = Shipment & {
  load: Load;
  proofOfDelivery: { mimeType: "image/jpeg" | "image/png" } | null;
  invoiceId: string | null;
};

export type TrackingKind = "PICKUP_ARRIVAL" | "PICKED_UP" | "GPS" | "DELIVERY_ARRIVAL";
export type Checkpoint = {
  id: string;
  kind: TrackingKind | "ASSIGNED" | "DELIVERED";
  occurredAt: string;
  latitude: number | null;
  longitude: number | null;
};

export type InvoiceDetail = {
  totalCents: number;
  detentionCharges: { stop: "PICKUP" | "DELIVERY"; amountCents: number; billableSeconds: number }[];
};

export const shipmentStatus = { ASSIGNED: "Assigned", IN_TRANSIT: "In transit", DELIVERED: "Delivered" };
export const checkpointLabels = {
  ASSIGNED: "Assigned", PICKUP_ARRIVAL: "Arrived at pickup", PICKED_UP: "Picked up",
  GPS: "GPS", DELIVERY_ARRIVAL: "Arrived at delivery", DELIVERED: "Delivered",
};

import { ShipmentPage } from "../../../../features/shipments/ShipmentPage";

export default async function ShipperShipment({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ShipmentPage key={id} shipmentId={id} role="shipper" />;
}

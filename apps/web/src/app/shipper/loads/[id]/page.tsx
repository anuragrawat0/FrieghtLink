import { LoadDetailPage } from "../../../../features/loads/LoadPages";

export default async function ShipperLoad({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LoadDetailPage key={id} id={id} role="shipper" />;
}

import { CarrierReviewPage } from "../../../../features/carriers/AdminCarrierPages";

export default async function ReviewCarrier({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CarrierReviewPage key={id} id={id} />;
}

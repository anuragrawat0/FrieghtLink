import Link from "next/link";

export default function Shipper() {
  return <><h1>Shipper</h1><Link href="/shipper/loads">Your loads</Link>{" · "}
    <Link href="/shipper/shipments">My shipments</Link></>;
}

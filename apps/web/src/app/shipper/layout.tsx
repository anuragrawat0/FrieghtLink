import type { ReactNode } from "react";
import { RoleHome } from "../../features/auth/RoleHome";

export default function ShipperLayout({ children }: { children: ReactNode }) {
  return <RoleHome role="SHIPPER">{children}</RoleHome>;
}

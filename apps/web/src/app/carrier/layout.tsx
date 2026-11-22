import type { ReactNode } from "react";
import { RoleHome } from "../../features/auth/RoleHome";

export default function CarrierLayout({ children }: { children: ReactNode }) {
  return <RoleHome role="CARRIER">{children}</RoleHome>;
}

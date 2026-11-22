import type { ReactNode } from "react";
import { RoleHome } from "../../features/auth/RoleHome";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <RoleHome role="ADMIN">{children}</RoleHome>;
}

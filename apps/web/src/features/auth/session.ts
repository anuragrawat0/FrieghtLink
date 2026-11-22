import { setAccessToken } from "../../lib/session";
import { disconnectSocket } from "../../lib/socket";

export const rolePages = {
  SHIPPER: { path: "/shipper", title: "Shipper" },
  CARRIER: { path: "/carrier", title: "Carrier" },
  ADMIN: { path: "/admin", title: "Admin" },
} as const;

export type Role = keyof typeof rolePages;
export type User = { id: string; email: string; displayName: string; role: Role; createdAt: string };
export type Auth = { user: User; accessToken: string };

export function endSession() {
  setAccessToken(null);
  disconnectSocket();
}

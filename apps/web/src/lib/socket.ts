import { io, type Socket } from "socket.io-client";
import { apiOrigin } from "./config";
import { getAccessToken } from "./session";

let socket: Socket | undefined;

export function connectSocket() {
  if (typeof window === "undefined") throw new Error("Socket.IO can only connect from the browser.");
  socket ??= io(apiOrigin, {
    path: "/socket.io",
    autoConnect: false,
    auth: (callback) => callback({ token: getAccessToken() }),
  });
  if (getAccessToken() && !socket.active) socket.connect();
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
}

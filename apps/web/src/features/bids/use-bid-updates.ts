import { useEffect } from "react";
import { connectSocket } from "../../lib/socket";

export function useBidUpdates(refresh: () => void, cancel: () => void, loadId?: string) {
  useEffect(() => {
    const socket = connectSocket();
    function onUpdate(event: { loadId: string }) {
      if (!loadId || event.loadId === loadId) refresh();
    }
    socket.on("connect", refresh);
    socket.on("bid:updated", onUpdate);
    socket.on("load:assigned", onUpdate);
    refresh();
    return () => {
      socket.off("connect", refresh);
      socket.off("bid:updated", onUpdate);
      socket.off("load:assigned", onUpdate);
      cancel();
    };
  }, [cancel, loadId, refresh]);
}

import type { IncomingMessage, ServerResponse } from "node:http";
import fp from "fastify-plugin";
import { Server } from "socket.io";
import type { BidStatus, InvoiceStatus, PaymentStatus, ShipmentStatus, VerificationStatus } from "../generated/prisma/client.js";
import { canReadShipment } from "../modules/shipments/access.js";
import type { AuthSession } from "./auth.js";
import { AppError, errorContext } from "../shared/errors.js";
import { isUuid } from "../shared/uuid.js";

type UserEvents = {
  "bid:updated": { loadId: string; bidId: string; status: BidStatus; currentRevision: number };
  "load:assigned": { loadId: string; shipmentId: string; bidId: string; status: "ASSIGNED" };
  "carrier:verificationChanged": { carrierProfileId: string; verificationStatus: VerificationStatus };
  "invoice:updated": { invoiceId: string; shipmentId: string; status: InvoiceStatus };
  "payment:updated": { invoiceId: string; paymentId: string; status: PaymentStatus };
  "payout:created": { statementId: string; invoiceId: string };
};
type ShipmentEvents = {
  "shipment:updated": { shipmentId: string; status: ShipmentStatus; checkpointId: string; sequence: number; currentEtaAt: string | null };
};
type RoomFailureCode = "VALIDATION_ERROR" | "NOT_FOUND" | "UNAUTHENTICATED" | "INTERNAL_ERROR";
type RoomAck = { ok: true } | { ok: false; error: { code: RoomFailureCode; message: string } };

declare module "fastify" {
  interface FastifyInstance {
    io: Server;
    emitToUser: <Event extends keyof UserEvents>(userId: string, event: Event, payload: UserEvents[Event]) => void;
    emitToShipment: <Event extends keyof ShipmentEvents>(shipmentId: string, event: Event, payload: ShipmentEvents[Event]) => void;
  }
}

function connectionError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code, message } });
}

function shipmentIdFrom(input: unknown) {
  if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !("shipmentId" in input)) return;
  if (isUuid(input.shipmentId)) return input.shipmentId.toLowerCase();
}

export const socketPlugin = fp<{ webOrigin: string }>(async (app, { webOrigin }) => {
  const io = new Server(app.server, {
    path: "/socket.io",
    cors: { origin: webOrigin },
  });

  io.engine.use((request: IncomingMessage, _response: ServerResponse, next: (error?: Error) => void) => {
    const origin = request.headers.origin;
    if (origin && origin !== webOrigin) return next(new Error("Origin is not allowed."));
    next();
  });

  io.use(async (socket, next) => {
    const token: unknown = socket.handshake.auth.token;
    if (typeof token !== "string") {
      return next(connectionError("UNAUTHENTICATED", "A valid access token is required."));
    }

    try {
      socket.data = await app.auth.authenticateAccessToken(token);
      next();
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) {
        return next(connectionError(error.code, error.message));
      }
      app.log.error({ failure: errorContext(error) }, "Socket authentication failed");
      next(connectionError("INTERNAL_ERROR", "Socket authentication could not be completed."));
    }
  });

  io.on("connection", (socket) => {
    const { user, expiresAt } = socket.data as AuthSession;
    void socket.join(`user:${user.id}`);
    const expiry = setTimeout(() => socket.disconnect(true), Math.max(0, expiresAt - Date.now()));
    socket.once("disconnect", () => clearTimeout(expiry));

    let roomChange = Promise.resolve();
    function changeRoom(subscribe: boolean, args: unknown[]) {
      const reply = args.at(-1);
      if (typeof reply !== "function") return;
      const ack = (response: RoomAck) => reply(response);
      roomChange = roomChange.then(async () => {
        const fail = (code: RoomFailureCode, message: string) => ack({ ok: false, error: { code, message } });
        const hasSession = () => socket.connected && Date.now() < expiresAt;
        const shipmentId = args.length === 2 ? shipmentIdFrom(args[0]) : undefined;
        if (!shipmentId) return fail("VALIDATION_ERROR", "A shipment UUID is required.");
        if (!hasSession()) return fail("UNAUTHENTICATED", "A valid access token is required.");

        try {
          if (subscribe) {
            const allowed = await canReadShipment(app.prisma, user, shipmentId);
            if (!hasSession()) return fail("UNAUTHENTICATED", "A valid access token is required.");
            if (!allowed) return fail("NOT_FOUND", "The shipment was not found.");
            await socket.join(`shipment:${shipmentId}`);
          } else {
            await socket.leave(`shipment:${shipmentId}`);
          }
          ack({ ok: true });
        } catch (error) {
          app.log.error({ failure: errorContext(error) }, "Shipment subscription failed");
          fail("INTERNAL_ERROR", "The shipment subscription could not be completed.");
        }
      });
    }

    socket.on("shipment:subscribe", (...args: unknown[]) => changeRoom(true, args));
    socket.on("shipment:unsubscribe", (...args: unknown[]) => changeRoom(false, args));
  });

  app.decorate("io", io);
  app.decorate("emitToUser", (userId, event, payload) => {
    io.to(`user:${userId.toLowerCase()}`).emit(event, payload);
  });
  app.decorate("emitToShipment", (shipmentId, event, payload) => {
    io.to(`shipment:${shipmentId.toLowerCase()}`).emit(event, payload);
  });
  app.addHook("preClose", async () => {
    io.disconnectSockets(true);
    io.engine.close();
  });
}, { name: "freightlink-socket", dependencies: ["freightlink-auth"] });

import type { ProofOfDelivery, TrackingCheckpoint } from "../../generated/prisma/client.js";

export function toCheckpointDto(checkpoint: TrackingCheckpoint) {
  const { id, shipmentId, sequence, kind, actorUserId, clientEventId, occurredAt, recordedAt, latitude, longitude } = checkpoint;
  return { id, shipmentId, sequence, kind, actorUserId, clientEventId,
    occurredAt: occurredAt.toISOString(), recordedAt: recordedAt.toISOString(), latitude, longitude };
}

export function toProofDto(proof: ProofOfDelivery) {
  const { id, shipmentId, mimeType, sizeBytes, uploadedAt } = proof;
  return { id, shipmentId, mimeType, sizeBytes, uploadedAt: uploadedAt.toISOString() };
}

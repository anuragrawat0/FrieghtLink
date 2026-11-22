import type { User } from "../auth/session";

export const safetyRatings = ["SATISFACTORY", "CONDITIONAL", "UNSATISFACTORY", "NOT_RATED"] as const;
export type VerificationStatus = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED";
export type Insurance = { id: string; mimeType: string; sizeBytes: number; uploadedAt: string };
export type CarrierProfile = {
  id: string;
  userId: string;
  motorCarrierLicense: string | null;
  safetyRating: typeof safetyRatings[number] | null;
  verificationStatus: VerificationStatus;
  verificationRevision: number;
  verificationSubmittedAt: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  insurance: Insurance | null;
};
export type AdminCarrier = { carrierProfile: CarrierProfile; user: User };

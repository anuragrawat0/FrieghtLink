import type { VerificationStatus } from "./types";

const labels: Record<VerificationStatus, string> = {
  DRAFT: "Draft", PENDING: "Pending review", APPROVED: "Approved", REJECTED: "Rejected",
};

export function VerificationBadge({ status }: { status: VerificationStatus }) {
  return <span role="status" style={{ border: "1px solid currentColor", borderRadius: 12, padding: "2px 8px" }}>{labels[status]}</span>;
}

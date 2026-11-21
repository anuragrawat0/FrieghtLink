BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SHIPPER', 'CARRIER', 'ADMIN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SafetyRating" AS ENUM ('SATISFACTORY', 'CONDITIONAL', 'UNSATISFACTORY', 'NOT_RATED');

-- CreateEnum
CREATE TYPE "LoadStatus" AS ENUM ('DRAFT', 'OPEN', 'ASSIGNED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BidStatus" AS ENUM ('ACTIVE', 'ACCEPTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('ASSIGNED', 'IN_TRANSIT', 'DELIVERED');

-- CreateEnum
CREATE TYPE "CheckpointKind" AS ENUM ('ASSIGNED', 'PICKUP_ARRIVAL', 'PICKED_UP', 'GPS', 'DELIVERY_ARRIVAL', 'DELIVERED');

-- CreateEnum
CREATE TYPE "StopType" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'PAID');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "displayName" VARCHAR(100) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierProfile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "motorCarrierLicense" VARCHAR(40),
    "safetyRating" "SafetyRating",
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'DRAFT',
    "verificationRevision" INTEGER NOT NULL DEFAULT 0,
    "verificationSubmittedAt" TIMESTAMPTZ(3),
    "reviewedByUserId" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewNote" VARCHAR(500),

    CONSTRAINT "CarrierProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierDocument" (
    "id" UUID NOT NULL,
    "carrierProfileId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" VARCHAR(50) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Load" (
    "id" UUID NOT NULL,
    "shipperId" UUID NOT NULL,
    "status" "LoadStatus" NOT NULL DEFAULT 'DRAFT',
    "description" VARCHAR(1000) NOT NULL,
    "pickupCity" VARCHAR(100) NOT NULL,
    "pickupRegion" CHAR(2) NOT NULL,
    "pickupLat" DOUBLE PRECISION NOT NULL,
    "pickupLng" DOUBLE PRECISION NOT NULL,
    "deliveryCity" VARCHAR(100) NOT NULL,
    "deliveryRegion" CHAR(2) NOT NULL,
    "deliveryLat" DOUBLE PRECISION NOT NULL,
    "deliveryLng" DOUBLE PRECISION NOT NULL,
    "pickupReadyAt" TIMESTAMPTZ(3) NOT NULL,
    "deliveryBy" TIMESTAMPTZ(3) NOT NULL,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Load_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" UUID NOT NULL,
    "loadId" UUID NOT NULL,
    "carrierProfileId" UUID NOT NULL,
    "status" "BidStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BidOffer" (
    "bidId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "authorUserId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BidOffer_pkey" PRIMARY KEY ("bidId","revision")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" UUID NOT NULL,
    "loadId" UUID NOT NULL,
    "acceptedBidId" UUID NOT NULL,
    "acceptedRevision" INTEGER NOT NULL,
    "carrierProfileId" UUID NOT NULL,
    "acceptedRateCents" INTEGER NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pickedUpAt" TIMESTAMPTZ(3),
    "deliveryArrivedAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "currentEtaAt" TIMESTAMPTZ(3),

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingCheckpoint" (
    "id" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "CheckpointKind" NOT NULL,
    "actorUserId" UUID,
    "clientEventId" UUID,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,

    CONSTRAINT "TrackingCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofOfDelivery" (
    "id" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" VARCHAR(50) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProofOfDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "linehaulCents" INTEGER NOT NULL,
    "detentionCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMPTZ(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetentionCharge" (
    "invoiceId" UUID NOT NULL,
    "stop" "StopType" NOT NULL,
    "arrivedAt" TIMESTAMPTZ(3) NOT NULL,
    "departedAt" TIMESTAMPTZ(3) NOT NULL,
    "freeMinutes" INTEGER NOT NULL,
    "hourlyRateCents" INTEGER NOT NULL,
    "billableSeconds" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "DetentionCharge_pkey" PRIMARY KEY ("invoiceId","stop")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amountCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkoutExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierPayoutStatement" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierPayoutStatement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierProfile_userId_key" ON "CarrierProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierProfile_motorCarrierLicense_key" ON "CarrierProfile"("motorCarrierLicense");

-- CreateIndex
CREATE INDEX "CarrierProfile_verificationStatus_verificationSubmittedAt_idx" ON "CarrierProfile"("verificationStatus", "verificationSubmittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierDocument_carrierProfileId_key" ON "CarrierDocument"("carrierProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierDocument_storageKey_key" ON "CarrierDocument"("storageKey");

-- CreateIndex
CREATE INDEX "Load_status_createdAt_id_idx" ON "Load"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Load_shipperId_createdAt_id_idx" ON "Load"("shipperId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Bid_loadId_status_idx" ON "Bid"("loadId", "status");

-- CreateIndex
CREATE INDEX "Bid_carrierProfileId_createdAt_id_idx" ON "Bid"("carrierProfileId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Bid_loadId_carrierProfileId_key" ON "Bid"("loadId", "carrierProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_loadId_key" ON "Shipment"("loadId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_acceptedBidId_key" ON "Shipment"("acceptedBidId");

-- CreateIndex
CREATE INDEX "Shipment_carrierProfileId_assignedAt_id_idx" ON "Shipment"("carrierProfileId", "assignedAt", "id");

-- CreateIndex
CREATE INDEX "Shipment_status_deliveredAt_idx" ON "Shipment"("status", "deliveredAt");

-- CreateIndex
CREATE INDEX "Shipment_assignedAt_id_idx" ON "Shipment"("assignedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingCheckpoint_shipmentId_sequence_key" ON "TrackingCheckpoint"("shipmentId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingCheckpoint_shipmentId_clientEventId_key" ON "TrackingCheckpoint"("shipmentId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ProofOfDelivery_shipmentId_key" ON "ProofOfDelivery"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProofOfDelivery_storageKey_key" ON "ProofOfDelivery"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_shipmentId_key" ON "Invoice"("shipmentId");

-- CreateIndex
CREATE INDEX "Invoice_issuedAt_id_idx" ON "Invoice"("issuedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripeCheckoutSessionId_key" ON "Payment"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_createdAt_id_idx" ON "Payment"("invoiceId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierPayoutStatement_invoiceId_key" ON "CarrierPayoutStatement"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierPayoutStatement_paymentId_key" ON "CarrierPayoutStatement"("paymentId");

-- CreateIndex
CREATE INDEX "CarrierPayoutStatement_createdAt_id_idx" ON "CarrierPayoutStatement"("createdAt", "id");

-- AddForeignKey
ALTER TABLE "CarrierProfile" ADD CONSTRAINT "CarrierProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierProfile" ADD CONSTRAINT "CarrierProfile_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierDocument" ADD CONSTRAINT "CarrierDocument_carrierProfileId_fkey" FOREIGN KEY ("carrierProfileId") REFERENCES "CarrierProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Load" ADD CONSTRAINT "Load_shipperId_fkey" FOREIGN KEY ("shipperId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_carrierProfileId_fkey" FOREIGN KEY ("carrierProfileId") REFERENCES "CarrierProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BidOffer" ADD CONSTRAINT "BidOffer_bidId_fkey" FOREIGN KEY ("bidId") REFERENCES "Bid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BidOffer" ADD CONSTRAINT "BidOffer_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_acceptedBidId_fkey" FOREIGN KEY ("acceptedBidId") REFERENCES "Bid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_carrierProfileId_fkey" FOREIGN KEY ("carrierProfileId") REFERENCES "CarrierProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingCheckpoint" ADD CONSTRAINT "TrackingCheckpoint_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingCheckpoint" ADD CONSTRAINT "TrackingCheckpoint_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetentionCharge" ADD CONSTRAINT "DetentionCharge_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierPayoutStatement" ADD CONSTRAINT "CarrierPayoutStatement_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierPayoutStatement" ADD CONSTRAINT "CarrierPayoutStatement_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints from docs/DATABASE_SCHEMA.md
ALTER TABLE "User"
  ADD CONSTRAINT "User_email_normalized_check"
  CHECK ("email" = lower("email") AND "email" !~ '^[[:space:]]|[[:space:]]$');

ALTER TABLE "CarrierProfile"
  ADD CONSTRAINT "CarrierProfile_verification_revision_check" CHECK ("verificationRevision" >= 0);

ALTER TABLE "CarrierDocument"
  ADD CONSTRAINT "CarrierDocument_size_check" CHECK ("sizeBytes" BETWEEN 1 AND 10485760),
  ADD CONSTRAINT "CarrierDocument_mime_check" CHECK ("mimeType" IN ('application/pdf', 'image/jpeg', 'image/png'));

ALTER TABLE "Load"
  ADD CONSTRAINT "Load_schedule_check" CHECK ("pickupReadyAt" < "deliveryBy"),
  ADD CONSTRAINT "Load_pickup_coordinates_check"
    CHECK ("pickupLat" BETWEEN -90 AND 90 AND "pickupLng" BETWEEN -180 AND 180),
  ADD CONSTRAINT "Load_delivery_coordinates_check"
    CHECK ("deliveryLat" BETWEEN -90 AND 90 AND "deliveryLng" BETWEEN -180 AND 180);

ALTER TABLE "Bid"
  ADD CONSTRAINT "Bid_current_revision_check" CHECK ("currentRevision" > 0);

ALTER TABLE "BidOffer"
  ADD CONSTRAINT "BidOffer_revision_check" CHECK ("revision" > 0),
  ADD CONSTRAINT "BidOffer_amount_check" CHECK ("amountCents" BETWEEN 50 AND 90000000);

ALTER TABLE "Shipment"
  ADD CONSTRAINT "Shipment_accepted_revision_check" CHECK ("acceptedRevision" > 0),
  ADD CONSTRAINT "Shipment_accepted_rate_check" CHECK ("acceptedRateCents" BETWEEN 50 AND 90000000);

ALTER TABLE "TrackingCheckpoint"
  ADD CONSTRAINT "TrackingCheckpoint_sequence_check" CHECK ("sequence" > 0),
  ADD CONSTRAINT "TrackingCheckpoint_coordinates_check" CHECK (
    ("kind" = 'GPS' AND "latitude" IS NOT NULL AND "longitude" IS NOT NULL
      AND "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180)
    OR ("kind" <> 'GPS' AND "latitude" IS NULL AND "longitude" IS NULL)
  ),
  ADD CONSTRAINT "TrackingCheckpoint_actor_and_event_check" CHECK (
    ("kind" = 'ASSIGNED' AND "actorUserId" IS NULL AND "clientEventId" IS NULL)
    OR ("kind" <> 'ASSIGNED' AND "actorUserId" IS NOT NULL AND "clientEventId" IS NOT NULL)
  );

ALTER TABLE "ProofOfDelivery"
  ADD CONSTRAINT "ProofOfDelivery_size_check" CHECK ("sizeBytes" BETWEEN 1 AND 5242880),
  ADD CONSTRAINT "ProofOfDelivery_mime_check" CHECK ("mimeType" IN ('image/jpeg', 'image/png'));

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_currency_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "Invoice_amounts_check" CHECK (
    "linehaulCents" BETWEEN 50 AND 90000000 AND "detentionCents" >= 0
    AND "totalCents" BETWEEN 50 AND 99999999
    AND "totalCents" = "linehaulCents"::bigint + "detentionCents"
  ),
  ADD CONSTRAINT "Invoice_paid_at_check" CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL));

ALTER TABLE "DetentionCharge"
  ADD CONSTRAINT "DetentionCharge_times_check" CHECK ("departedAt" >= "arrivedAt"),
  ADD CONSTRAINT "DetentionCharge_amounts_check" CHECK (
    "freeMinutes" >= 0 AND "hourlyRateCents" >= 0
    AND "billableSeconds" BETWEEN 0 AND 604800 AND "amountCents" >= 0
  );

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_currency_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "Payment_amount_check" CHECK ("amountCents" BETWEEN 50 AND 99999999),
  ADD CONSTRAINT "Payment_resolved_at_check" CHECK (("status" IN ('SUCCEEDED', 'FAILED')) = ("resolvedAt" IS NOT NULL)),
  ADD CONSTRAINT "Payment_success_stripe_ids_check" CHECK (
    "status" <> 'SUCCEEDED' OR ("stripeCheckoutSessionId" IS NOT NULL AND "stripePaymentIntentId" IS NOT NULL)
  ),
  ADD CONSTRAINT "Payment_checkout_expiry_check" CHECK ("checkoutExpiresAt" > "createdAt");

ALTER TABLE "CarrierPayoutStatement"
  ADD CONSTRAINT "CarrierPayoutStatement_currency_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "CarrierPayoutStatement_amount_check" CHECK ("amountCents" BETWEEN 50 AND 99999999);

-- One winning bid, one of each non-GPS milestone and one active or successful payment.
CREATE UNIQUE INDEX "Bid_one_accepted_per_load" ON "Bid" ("loadId") WHERE "status" = 'ACCEPTED';
CREATE UNIQUE INDEX "TrackingCheckpoint_one_per_milestone"
  ON "TrackingCheckpoint" ("shipmentId", "kind") WHERE "kind" <> 'GPS';
CREATE UNIQUE INDEX "Payment_one_pending_or_succeeded_per_invoice"
  ON "Payment" ("invoiceId") WHERE "status" IN ('PENDING', 'SUCCEEDED');

COMMIT;

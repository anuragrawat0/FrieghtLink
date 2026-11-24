import type { FastifyInstance } from "fastify";
import { Prisma, type Role, type SafetyRating, type VerificationStatus } from "../../generated/prisma/client.js";
import type { AuthenticatedUser } from "../../plugins/auth.js";
import { AppError, errorContext } from "../../shared/errors.js";
import { withSerializableTransaction } from "../../shared/transactions.js";
import { toUserDto } from "../users/service.js";

export type ProfileInput = { motorCarrierLicense?: string; safetyRating?: SafetyRating };
export type ReviewInput = { decision: "APPROVED" | "REJECTED"; expectedRevision: number; reviewNote?: string };
export type CarrierQuery = { limit?: number; offset?: number; status?: VerificationStatus };

const includeInsurance = { insurance: true } as const;
const includeAccount = {
  ...includeInsurance,
  user: { select: { id: true, email: true, displayName: true, role: true, createdAt: true } },
} as const;
type Profile = Prisma.CarrierProfileGetPayload<{ include: typeof includeInsurance }>;
type Document = NonNullable<Profile["insurance"]>;
type SavedInsurance = Awaited<ReturnType<FastifyInstance["uploads"]["save"]>>;

function requireRole(user: AuthenticatedUser, role: Role) {
  if (user.role !== role) throw new AppError(403, "FORBIDDEN", "This action is unavailable to your role.");
}

function notFound() {
  return new AppError(404, "NOT_FOUND", "The requested resource was not found.");
}

function requireEditable(profile: Profile) {
  if (profile.verificationStatus !== "DRAFT" && profile.verificationStatus !== "REJECTED") {
    throw new AppError(409, "PROFILE_LOCKED", "The carrier profile is locked for editing.");
  }
}

async function ownProfile(db: Prisma.TransactionClient, user: AuthenticatedUser) {
  requireRole(user, "CARRIER");
  const profile = await db.carrierProfile.findUnique({ where: { userId: user.id }, include: includeInsurance });
  if (!profile) throw notFound();
  return profile;
}

function toInsuranceDto({ id, mimeType, sizeBytes, uploadedAt }: Document) {
  return { id, mimeType, sizeBytes, uploadedAt: uploadedAt.toISOString() };
}

function toProfileDto(profile: Profile) {
  const { insurance, verificationSubmittedAt, reviewedAt, ...fields } = profile;
  return {
    ...fields,
    verificationSubmittedAt: verificationSubmittedAt?.toISOString() ?? null,
    reviewedAt: reviewedAt?.toISOString() ?? null,
    insurance: insurance ? toInsuranceDto(insurance) : null,
  };
}

function toAdminCarrierDto({ user, ...profile }: Prisma.CarrierProfileGetPayload<{ include: typeof includeAccount }>) {
  return { carrierProfile: toProfileDto(profile), user: toUserDto(user) };
}

function emitVerification(app: FastifyInstance, profile: Profile) {
  app.emitToUser(profile.userId, "carrier:verificationChanged", {
    carrierProfileId: profile.id, verificationStatus: profile.verificationStatus,
  });
}

export async function createDraftProfile(tx: Prisma.TransactionClient, userId: string) {
  await tx.carrierProfile.create({ data: { userId, verificationStatus: "DRAFT" } });
}

export async function readApprovedCarrierId(db: Prisma.TransactionClient, userId: string) {
  const profile = await db.carrierProfile.findUnique({
    where: { userId, verificationStatus: "APPROVED" }, select: { id: true },
  });
  return profile?.id;
}

export async function isCarrierApproved(db: Prisma.TransactionClient, userId: string) {
  return Boolean(await readApprovedCarrierId(db, userId));
}

export async function readOwnProfile(db: Prisma.TransactionClient, user: AuthenticatedUser) {
  return toProfileDto(await ownProfile(db, user));
}

export async function updateProfile(app: FastifyInstance, user: AuthenticatedUser, input: ProfileInput) {
  try {
    const updated = await withSerializableTransaction(app.prisma, async (tx) => {
      const profile = await ownProfile(tx, user);
      requireEditable(profile);
      return tx.carrierProfile.update({ where: { id: profile.id }, data: input, include: includeInsurance });
    });
    return toProfileDto(updated);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "LICENSE_IN_USE", "That motor carrier license is already in use.");
    }
    throw error;
  }
}

export async function removeUnreferencedInsurance(app: FastifyInstance, storageKey: string) {
  try {
    const reference = await app.prisma.carrierDocument.findUnique({ where: { storageKey }, select: { id: true } });
    if (!reference) await app.uploads.remove(storageKey);
  } catch (error) {
    app.log.warn({ failure: errorContext(error) }, "Could not clean up an insurance file");
  }
}

export async function replaceInsurance(app: FastifyInstance, user: AuthenticatedUser, saved: SavedInsurance) {
  const { storageKey, mimeType, sizeBytes } = saved;
  const { document, priorKey } = await withSerializableTransaction(app.prisma, async (tx) => {
    const profile = await ownProfile(tx, user);
    requireEditable(profile);
    // Serialize replacements even when there is no document row yet.
    await tx.carrierProfile.update({ where: { id: profile.id }, data: { verificationStatus: profile.verificationStatus } });
    if (profile.insurance) await tx.carrierDocument.delete({ where: { id: profile.insurance.id } });
    const document = await tx.carrierDocument.create({
      data: { carrierProfileId: profile.id, storageKey, mimeType, sizeBytes },
    });
    return { document, priorKey: profile.insurance?.storageKey };
  });
  if (priorKey) await removeUnreferencedInsurance(app, priorKey);
  return toInsuranceDto(document);
}

export async function openInsurance(app: FastifyInstance, user: AuthenticatedUser, carrierProfileId?: string) {
  const profile = carrierProfileId === undefined
    ? await ownProfile(app.prisma, user)
    : await adminProfile(app.prisma, user, carrierProfileId);
  if (!profile.insurance) throw notFound();
  return { mimeType: profile.insurance.mimeType, stream: await app.uploads.open(profile.insurance.storageKey) };
}

export async function submitVerification(app: FastifyInstance, user: AuthenticatedUser) {
  // Insurance can be replaced between checking the file and starting the transaction.
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await ownProfile(app.prisma, user);
    requireEditable(candidate);
    const storageKey = candidate.insurance?.storageKey;
    let fileAvailable = false;
    if (storageKey) {
      try {
        const stream = await app.uploads.open(storageKey);
        stream.destroy();
        fileAvailable = true;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "FILE_UNAVAILABLE") throw error;
      }
    }

    const submitted = await withSerializableTransaction(app.prisma, async (tx) => {
      const profile = await ownProfile(tx, user);
      requireEditable(profile);
      if (storageKey !== profile.insurance?.storageKey) return null;
      if (!profile.motorCarrierLicense || !profile.safetyRating || !fileAvailable) {
        throw new AppError(422, "VERIFICATION_INCOMPLETE", "A license, safety rating and insurance certificate are required.");
      }
      return tx.carrierProfile.update({
        where: { id: profile.id },
        include: includeInsurance,
        data: {
          verificationStatus: "PENDING", verificationRevision: { increment: 1 }, verificationSubmittedAt: new Date(),
          reviewedByUserId: null, reviewedAt: null, reviewNote: null,
        },
      });
    });
    if (submitted) {
      emitVerification(app, submitted);
      return toProfileDto(submitted);
    }
  }
  throw new AppError(503, "CONCURRENT_UPDATE", "The resource changed concurrently. Try again.");
}

async function adminProfile(db: Prisma.TransactionClient, user: AuthenticatedUser, id: string) {
  requireRole(user, "ADMIN");
  const profile = await db.carrierProfile.findUnique({ where: { id }, include: includeAccount });
  if (!profile) throw notFound();
  return profile;
}

export async function readAdminCarrier(db: Prisma.TransactionClient, user: AuthenticatedUser, id: string) {
  return toAdminCarrierDto(await adminProfile(db, user, id));
}

export async function listAdminCarriers(db: Prisma.TransactionClient, user: AuthenticatedUser, query: CarrierQuery) {
  requireRole(user, "ADMIN");
  const { limit = 20, offset = 0, status = "PENDING" } = query;
  const rows = await db.carrierProfile.findMany({
    where: { verificationStatus: status }, include: includeAccount,
    orderBy: [{ verificationSubmittedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    skip: offset, take: limit + 1,
  });
  return { data: rows.slice(0, limit).map(toAdminCarrierDto), meta: { limit, offset, hasMore: rows.length > limit } };
}

export async function reviewCarrier(app: FastifyInstance, user: AuthenticatedUser, id: string, input: ReviewInput) {
  const reviewed = await withSerializableTransaction(app.prisma, async (tx) => {
    const profile = await adminProfile(tx, user, id);
    if (profile.verificationStatus !== "PENDING") {
      throw new AppError(409, "VERIFICATION_NOT_PENDING", "The carrier submission is no longer pending.");
    }
    if (profile.verificationRevision !== input.expectedRevision) {
      throw new AppError(409, "STALE_VERIFICATION", "The carrier has a newer pending submission.");
    }
    return tx.carrierProfile.update({
      where: { id }, include: includeInsurance,
      data: {
        verificationStatus: input.decision, reviewedByUserId: user.id, reviewedAt: new Date(),
        reviewNote: input.reviewNote ?? null,
      },
    });
  });
  emitVerification(app, reviewed);
  return toProfileDto(reviewed);
}

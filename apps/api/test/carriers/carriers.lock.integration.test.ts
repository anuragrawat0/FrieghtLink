import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import type { Role } from "../../src/generated/prisma/client.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const prefix = `carriers-lock-${randomUUID()}-`;
const base = "/api/v1";
const me = `${base}/carriers/me`;
const pdf = "%PDF-1.7\ncarriers lock certificate";
let app: ReturnType<typeof buildApp>;
let uploadDir: string;

type Account = {
  id: string;
  headers: { authorization: string };
  profileId?: string;
};

beforeAll(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), "freightlink-carriers-lock-"));
  app = buildApp(readConfig({
    NODE_ENV: "test", DATABASE_URL: requireTestDatabaseUrl(), JWT_SECRET: randomUUID(), UPLOAD_DIR: uploadDir,
  }));
  await app.ready();
});

afterAll(async () => {
  try {
    if (app?.prisma) {
      const email = { startsWith: prefix };
      await app.prisma.carrierDocument.deleteMany({ where: { carrierProfile: { user: { email } } } });
      await app.prisma.carrierProfile.deleteMany({ where: { user: { email } } });
      await app.prisma.user.deleteMany({ where: { email } });
    }
  } finally {
    await app?.close();
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  }
});

async function account(role: Role, name: string): Promise<Account> {
  const user = await app.prisma.user.create({
    data: { email: `${prefix}${name}@example.test`, displayName: name, role, passwordHash: "fixture" },
  });
  const profile = role === "CARRIER" ? await app.prisma.carrierProfile.create({ data: { userId: user.id } }) : undefined;
  return {
    id: user.id,
    headers: { authorization: `Bearer ${await app.auth.signAccessToken(user.id)}` },
    profileId: profile?.id,
  };
}

function upload(headers: Record<string, string>, bytes = pdf) {
  const boundary = "freightlink-lock-test-part";
  const file = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="insurance.pdf"\r\nContent-Type: application/pdf\r\n\r\n${bytes}\r\n`;
  return app.inject({
    method: "PUT", url: `${me}/insurance`,
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: `${file}--${boundary}--\r\n`,
  });
}

function patch(headers: Record<string, string>, payload: object) {
  return app.inject({ method: "PATCH", url: me, headers, payload });
}

async function submit(headers: Record<string, string>) {
  return app.inject({ method: "POST", url: `${me}/verification`, headers });
}

it("locks profile edits and insurance uploads once the profile is approved", async () => {
  const carrier = await account("CARRIER", "carrier");
  const admin = await account("ADMIN", "admin");
  const shipper = await account("SHIPPER", "shipper");
  const otherCarrier = await account("CARRIER", "other-carrier");
  const license = randomUUID().toUpperCase();

  expect((await upload(carrier.headers)).statusCode).toBe(200);
  expect((await patch(carrier.headers, { motorCarrierLicense: license, safetyRating: "SATISFACTORY" })).statusCode).toBe(200);
  expect((await submit(carrier.headers)).json().data).toMatchObject({
    verificationStatus: "PENDING", verificationRevision: 1,
  });
  expect((await app.inject({
    method: "POST", url: `${base}/admin/carriers/${carrier.profileId}/review`, headers: admin.headers,
    payload: { decision: "APPROVED", expectedRevision: 1 },
  })).json().data.verificationStatus).toBe("APPROVED");

  const lockedPatch = await patch(carrier.headers, { safetyRating: "NOT_RATED" });
  expect(lockedPatch.statusCode).toBe(409);
  expect(lockedPatch.json().error.code).toBe("PROFILE_LOCKED");

  const lockedUpload = await upload(carrier.headers);
  expect(lockedUpload.statusCode).toBe(409);
  expect(lockedUpload.json().error.code).toBe("PROFILE_LOCKED");
  expect(await readdir(uploadDir)).toHaveLength(1);

  const ownDownload = await app.inject({ url: `${me}/insurance`, headers: carrier.headers });
  expect(ownDownload.statusCode).toBe(200);
  expect(ownDownload.body).toBe(pdf);
  expect(ownDownload.headers).toMatchObject({
    "content-type": "application/pdf",
    "x-content-type-options": "nosniff",
    "content-disposition": "attachment",
    "cache-control": "private, no-store",
  });

  const adminDownload = await app.inject({
    url: `${base}/admin/carriers/${carrier.profileId}/insurance`, headers: admin.headers,
  });
  expect(adminDownload.statusCode).toBe(200);
  expect(adminDownload.body).toBe(pdf);
  expect(adminDownload.headers).toMatchObject({
    "content-type": "application/pdf",
    "x-content-type-options": "nosniff",
    "content-disposition": "attachment",
    "cache-control": "private, no-store",
  });

  expect((await app.inject({ url: `${me}/insurance`, headers: shipper.headers })).statusCode).toBe(403);
  expect((await app.inject({ url: `${me}/insurance`, headers: otherCarrier.headers })).statusCode).toBe(404);
  expect((await app.inject({
    url: `${base}/admin/carriers/${carrier.profileId}/insurance`, headers: otherCarrier.headers,
  })).statusCode).toBe(403);

  const adminEdit = await patch(admin.headers, { safetyRating: "SATISFACTORY" });
  expect(adminEdit.statusCode).toBe(403);
  expect(adminEdit.json().error.code).toBe("FORBIDDEN");
});

it("requires a license and a safety rating separately before submission", async () => {
  const missingLicense = await account("CARRIER", "missing-license");
  expect((await upload(missingLicense.headers)).statusCode).toBe(200);
  expect((await patch(missingLicense.headers, { safetyRating: "SATISFACTORY" })).statusCode).toBe(200);
  const noLicense = await submit(missingLicense.headers);
  expect(noLicense.statusCode).toBe(422);
  expect(noLicense.json().error.code).toBe("VERIFICATION_INCOMPLETE");

  const missingRating = await account("CARRIER", "missing-rating");
  expect((await upload(missingRating.headers)).statusCode).toBe(200);
  expect((await patch(missingRating.headers, { motorCarrierLicense: randomUUID().toUpperCase() })).statusCode).toBe(200);
  const noRating = await submit(missingRating.headers);
  expect(noRating.statusCode).toBe(422);
  expect(noRating.json().error.code).toBe("VERIFICATION_INCOMPLETE");

  const missingFile = await account("CARRIER", "missing-file");
  expect((await patch(missingFile.headers, {
    motorCarrierLicense: randomUUID().toUpperCase(), safetyRating: "SATISFACTORY",
  })).statusCode).toBe(200);
  const noFile = await submit(missingFile.headers);
  expect(noFile.statusCode).toBe(422);
  expect(noFile.json().error.code).toBe("VERIFICATION_INCOMPLETE");
});

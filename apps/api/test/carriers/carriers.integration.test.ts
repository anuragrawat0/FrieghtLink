import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import type { Role } from "../../src/generated/prisma/client.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const prefix = `carrier-${randomUUID()}-`;
const base = "/api/v1";
const me = `${base}/carriers/me`;
const queue = `${base}/admin/carriers`;
let app: ReturnType<typeof buildApp>;
let uploadDir: string;

beforeAll(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), "freightlink-carriers-"));
  app = buildApp(readConfig({ NODE_ENV: "test", DATABASE_URL: requireTestDatabaseUrl(), JWT_SECRET: randomUUID(), UPLOAD_DIR: uploadDir }));
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

async function account(role: Role, name: string) {
  const user = await app.prisma.user.create({
    data: { email: `${prefix}${name}@example.test`, displayName: name, role, passwordHash: "fixture" },
  });
  const profile = role === "CARRIER" ? await app.prisma.carrierProfile.create({ data: { userId: user.id } }) : undefined;
  const headers = { authorization: `Bearer ${await app.auth.signAccessToken(user.id)}` };
  return { user, headers, profileId: profile?.id };
}

const pdf = "%PDF-1.7\ncarrier certificate";
function upload(headers: Record<string, string>, bytes = pdf, extra = false) {
  const boundary = "freightlink-test-part";
  const file = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="insurance.pdf"\r\nContent-Type: text/plain\r\n\r\n${bytes}\r\n`;
  const field = `--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\ninvalid\r\n`;
  return app.inject({
    method: "PUT", url: `${me}/insurance`, headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: `${file}${extra ? field : ""}--${boundary}--\r\n`,
  });
}

it("authenticates before parsing a malformed body", async () => {
  const result = await app.inject({ method: "PATCH", url: me, headers: { "content-type": "application/json" }, payload: "{" });
  expect(result.statusCode).toBe(401);
  expect(result.json().error.code).toBe("UNAUTHENTICATED");
});

it("validates onboarding, protects downloads and runs revisioned decisions with one concurrent winner", async () => {
  const carrier = await account("CARRIER", "carrier");
  const other = await account("CARRIER", "other");
  const admin = await account("ADMIN", "admin");
  const reviewUrl = `${queue}/${carrier.profileId}`;
  const headers = carrier.headers;
  const license = `${randomUUID()}`.toUpperCase();
  const patch = (payload: object, auth = headers) => app.inject({ method: "PATCH", url: me, headers: auth, payload });
  const submit = () => app.inject({ method: "POST", url: `${me}/verification`, headers });
  const review = (payload: object) => app.inject({ method: "POST", url: `${reviewUrl}/review`, headers: admin.headers, payload });
  const emit = vi.spyOn(app, "emitToUser");

  expect((await app.inject({ url: me, headers })).json().data).toMatchObject({ verificationStatus: "DRAFT", insurance: null });
  expect((await app.inject({ url: me, headers: admin.headers })).statusCode).toBe(403);
  expect((await app.inject({ url: reviewUrl, headers: other.headers })).statusCode).toBe(403);
  expect((await app.inject({ url: `${me}/insurance`, headers: other.headers })).statusCode).toBe(404);
  expect((await patch({})).statusCode).toBe(400);
  expect((await patch({ motorCarrierLicense: 1 })).statusCode).toBe(400);
  expect((await patch({ safetyRating: "INVALID" })).statusCode).toBe(400);
  expect((await submit()).json().error.code).toBe("VERIFICATION_INCOMPLETE");
  expect((await patch({ motorCarrierLicense: ` ${license.toLowerCase()} `, safetyRating: "SATISFACTORY" })).json().data.motorCarrierLicense).toBe(license);
  expect((await patch({ motorCarrierLicense: license }, other.headers)).json().error.code).toBe("LICENSE_IN_USE");
  expect((await upload(headers, "not a document")).statusCode).toBe(415);
  expect((await upload(headers, pdf + "x".repeat(10 * 1024 * 1024))).statusCode).toBe(413);
  expect((await upload(headers, pdf, true)).statusCode).toBe(400);
  expect(await readdir(uploadDir)).toEqual([]);

  const uploads = await Promise.all([upload(headers), upload(headers, `${pdf}\nnew`)]);
  for (const response of uploads) {
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({ id: expect.any(String), mimeType: "application/pdf", uploadedAt: expect.any(String), sizeBytes: expect.any(Number) });
  }
  expect(new Set(uploads.map((response) => response.json().data.id)).size).toBe(2);
  expect(await readdir(uploadDir)).toHaveLength(1);
  const ownDownload = await app.inject({ url: `${me}/insurance`, headers });
  expect(ownDownload.body).toMatch(/^%PDF-1\.7/);
  const certificate = await app.inject({ url: `${reviewUrl}/insurance`, headers: admin.headers });
  expect(certificate.body).toBe(ownDownload.body);
  expect(certificate.headers).toMatchObject({
    "content-type": "application/pdf", "x-content-type-options": "nosniff", "content-disposition": "attachment", "cache-control": "private, no-store",
  });

  const [storedFile] = await readdir(uploadDir);
  await rm(join(uploadDir, storedFile));
  expect((await app.inject({ url: `${reviewUrl}/insurance`, headers: admin.headers })).json().error.code).toBe("FILE_UNAVAILABLE");
  expect((await submit()).json().error.code).toBe("VERIFICATION_INCOMPLETE");
  expect((await upload(headers)).statusCode).toBe(200);

  expect((await submit()).json().data).toMatchObject({ verificationStatus: "PENDING", verificationRevision: 1 });
  expect((await app.inject({ url: queue, headers: admin.headers })).json().data).toContainEqual({
    carrierProfile: expect.objectContaining({ id: carrier.profileId, verificationStatus: "PENDING" }),
    user: { id: carrier.user.id, email: carrier.user.email, displayName: "carrier", role: "CARRIER", createdAt: expect.any(String) },
  });
  expect((await app.inject({ url: reviewUrl, headers: admin.headers })).json().data.carrierProfile.id).toBe(carrier.profileId);
  expect((await patch({ safetyRating: "NOT_RATED" })).json().error.code).toBe("PROFILE_LOCKED");
  expect((await upload(headers)).json().error.code).toBe("PROFILE_LOCKED");
  expect(await readdir(uploadDir)).toHaveLength(1);
  expect((await review({ decision: "REJECTED", expectedRevision: 1, reviewNote: "   " })).statusCode).toBe(400);
  expect((await review({ decision: "REJECTED", expectedRevision: 1, reviewNote: "  Update insurance.  " })).json().data).toMatchObject({
    verificationStatus: "REJECTED", reviewNote: "Update insurance.", reviewedByUserId: admin.user.id,
  });
  expect((await patch({ safetyRating: "CONDITIONAL" })).statusCode).toBe(200);
  expect((await submit()).json().data).toMatchObject({ verificationRevision: 2, reviewedByUserId: null, reviewedAt: null, reviewNote: null });
  expect((await review({ decision: "APPROVED", expectedRevision: 1 })).json().error.code).toBe("STALE_VERIFICATION");
  const decisions = await Promise.all(Array.from({ length: 2 }, () => review({ decision: "APPROVED", expectedRevision: 2 })));
  expect(decisions.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
  expect(decisions.find(({ statusCode }) => statusCode === 409)?.json().error.code).toBe("VERIFICATION_NOT_PENDING");
  expect((await submit()).json().error.code).toBe("PROFILE_LOCKED");
  expect(emit.mock.calls).toEqual(["PENDING", "REJECTED", "PENDING", "APPROVED"].map((verificationStatus) => [
    carrier.user.id, "carrier:verificationChanged", { carrierProfileId: carrier.profileId, verificationStatus },
  ]));
  emit.mockRestore();
});

it("keeps concurrent writes to one carrier profile within the API conflict contract", async () => {
  const { headers, profileId } = await account("CARRIER", "concurrent-writes");
  const patch = (payload: object) => app.inject({ method: "PATCH", url: me, headers, payload });
  expect((await patch({ motorCarrierLicense: randomUUID(), safetyRating: "SATISFACTORY" })).statusCode).toBe(200);
  expect((await upload(headers)).statusCode).toBe(200);

  const responses = await Promise.all([
    ...Array.from({ length: 4 }, (_, index) => upload(headers, `${pdf}\nrevision ${index}`)),
    patch({ safetyRating: "CONDITIONAL" }),
    patch({ safetyRating: "NOT_RATED" }),
    app.inject({ method: "POST", url: `${me}/verification`, headers }),
  ]);
  for (const response of responses) {
    expect([200, 409, 503], response.body).toContain(response.statusCode);
    if (response.statusCode === 409) expect(response.json().error.code).toBe("PROFILE_LOCKED");
    if (response.statusCode === 503) expect(response.json().error.code).toBe("CONCURRENT_UPDATE");
  }
  expect(responses.some(({ statusCode }) => statusCode === 200)).toBe(true);
  expect(await app.prisma.carrierDocument.count({ where: { carrierProfileId: profileId } })).toBe(1);
});

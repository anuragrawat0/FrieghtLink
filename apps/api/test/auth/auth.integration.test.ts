import { randomBytes, randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import { seedDemoAdmin } from "../../src/modules/auth/admin-seed.js";
import * as carriers from "../../src/modules/carriers/service.js";
import { requireTestDatabaseUrl } from "../setup/database.js";

const prefix = `auth-${randomUUID()}-`;
const password = "  FreightLink test password  ";
const jwtSecret = randomBytes(32).toString("hex");
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp(readConfig({ NODE_ENV: "test", DATABASE_URL: requireTestDatabaseUrl(), JWT_SECRET: jwtSecret }));
  await app.ready();
});

afterAll(async () => {
  if (!app) return;
  try {
    const email = { startsWith: prefix };
    await app.prisma?.carrierProfile.deleteMany({ where: { user: { email } } });
    await app.prisma?.user.deleteMany({ where: { email } });
  } finally {
    await app.close();
  }
});

function registration(name: string, role: "SHIPPER" | "CARRIER" = "SHIPPER") {
  return { email: `${prefix}${name}@example.test`, password, displayName: "  Test User  ", role };
}

function post(path: "register" | "login", payload: object, remoteAddress: string) {
  return app.inject({ method: "POST", url: `/api/v1/auth/${path}`, payload, remoteAddress });
}

function me(token?: string, query = "") {
  return app.inject({ url: `/api/v1/users/me${query}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

it("registers shippers and carriers, signs contract tokens, and returns the authenticated user", async () => {
  for (const role of ["SHIPPER", "CARRIER"] as const) {
    const input = registration(role.toLowerCase(), role);
    const response = await post("register", { ...input, email: `  ${input.email.toUpperCase()}  ` }, "192.0.2.1");
    expect(response.statusCode).toBe(201);
    const { user, accessToken } = response.json().data;
    expect(response.json()).toEqual({ data: { user: {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), email: input.email, displayName: "Test User", role,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    }, accessToken: expect.any(String) } });
    const claims = decodeJwt(accessToken);
    expect(decodeProtectedHeader(accessToken).alg).toBe("HS256");
    expect(claims).toMatchObject({ sub: user.id, iss: "freightlink-api", aud: "freightlink-web", iat: expect.any(Number) });
    expect(claims.exp! - claims.iat!).toBe(3600);
    const current = await me(accessToken);
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual({ data: user });

    const profile = await app.prisma.carrierProfile.findUnique({ where: { userId: user.id } });
    if (role === "CARRIER") expect(profile).toMatchObject({ verificationStatus: "DRAFT", verificationRevision: 0 });
    else expect(profile).toBeNull();

    const login = await post("login", { email: ` ${input.email.toUpperCase()} `, password }, "192.0.2.1");
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ data: { user, accessToken: expect.any(String) } });
  }
});

it("rejects unknown fields and invalid input types, syntax, lengths, and public admin registration", async () => {
  const input = registration("invalid");
  const invalidFields = [
    { role: "ADMIN" }, { email: "a..b@example.test" }, { email: `${"a".repeat(243)}@example.test` },
    { password: "too-short" }, { password: "x".repeat(129) }, { password: 123456789012 },
    { displayName: "   " }, { displayName: "x".repeat(101) }, { extra: "unexpected" },
  ];
  for (const fields of invalidFields) {
    const response = await post("register", { ...input, ...fields }, "192.0.2.2");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  }
  const response = await post("login", { email: input.email, password, role: "ADMIN" }, "192.0.2.2");
  expect(response.statusCode).toBe(400);
  expect(await app.prisma.user.count({ where: { email: input.email } })).toBe(0);
});

it("uses the same error for an unknown email and a wrong password", async () => {
  const input = registration("wrong-password");
  expect((await post("register", input, "192.0.2.3")).statusCode).toBe(201);
  const wrong = await post("login", { email: input.email, password: password.trim() }, "192.0.2.3");
  const short = await post("login", { email: input.email, password: "wrong" }, "192.0.2.3");
  const unknown = await post("login", { email: registration("unknown").email, password }, "192.0.2.3");
  for (const response of [wrong, short, unknown]) {
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toEqual({
      code: "INVALID_CREDENTIALS", message: "The email or password is incorrect.", requestId: expect.any(String),
    });
  }
});

it("requires a valid token for a current account and rejects query parameters", async () => {
  const response = await post("register", registration("identity"), "192.0.2.4");
  expect(response.statusCode).toBe(201);
  const { user, accessToken } = response.json().data;
  const now = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(user.id)
    .setIssuer("freightlink-api").setAudience("freightlink-web").setIssuedAt(now - 3601).setExpirationTime(now - 1)
    .sign(new TextEncoder().encode(jwtSecret));
  const missingUser = await app.auth.signAccessToken(randomUUID());

  for (const token of [undefined, "invalid", expired, missingUser]) {
    const denied = await me(token);
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe("UNAUTHENTICATED");
  }
  const wrongQuery = await me(accessToken, `?userId=${randomUUID()}`);
  expect(wrongQuery.statusCode).toBe(400);
  expect(wrongQuery.json().error.code).toBe("VALIDATION_ERROR");
});

it("keeps one user and one draft when equivalent registrations race", async () => {
  const input = registration("race", "CARRIER");
  const responses = await Promise.all([
    post("register", input, "192.0.2.5"),
    post("register", { ...input, email: ` ${input.email.toUpperCase()} ` }, "192.0.2.5"),
  ]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  const duplicate = responses.find((response) => response.statusCode === 409);
  expect(duplicate?.json().error.code).toBe("EMAIL_IN_USE");
  const users = await app.prisma.user.findMany({ where: { email: input.email }, include: { carrierProfile: true } });
  expect(users).toHaveLength(1);
  expect(users[0].carrierProfile?.verificationStatus).toBe("DRAFT");
});

it("rolls back user creation when creating the carrier profile fails", async () => {
  const input = registration("rollback", "CARRIER");
  const failProfile = vi.spyOn(carriers, "createDraftProfile").mockRejectedValueOnce(new Error("Profile creation failed"));
  try {
    const response = await post("register", input, "192.0.2.6");
    expect(failProfile).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(500);
    expect(await app.prisma.user.count({ where: { email: input.email } })).toBe(0);
  } finally {
    failProfile.mockRestore();
  }
});

it("limits both auth routes to ten requests per minute per IP independently", async () => {
  for (const path of ["register", "login"] as const) {
    for (let count = 0; count < 10; count++) {
      expect((await post(path, {}, "192.0.2.7")).statusCode).toBe(400);
    }
    const limited = await post(path, {}, "192.0.2.7");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect((await post(path, {}, "192.0.2.8")).statusCode).toBe(400);
  }
});

it("seeds one admin idempotently, retains its password, and refuses a non-admin email", async () => {
  const email = registration("seed").email;
  const config = { DEMO_ADMIN_EMAIL: ` ${email.toUpperCase()} `, DEMO_ADMIN_PASSWORD: password };
  await Promise.all([seedDemoAdmin(app.prisma, config), seedDemoAdmin(app.prisma, config)]);
  const admin = await app.prisma.user.findUniqueOrThrow({ where: { email } });
  await seedDemoAdmin(app.prisma, { ...config, DEMO_ADMIN_PASSWORD: "a different admin password" });
  const repeated = await app.prisma.user.findUniqueOrThrow({ where: { email } });
  expect(repeated).toMatchObject({ id: admin.id, role: "ADMIN", passwordHash: admin.passwordHash });
  const login = await post("login", { email, password }, "192.0.2.9");
  expect(login.statusCode).toBe(200);
  expect(login.json().data.user.role).toBe("ADMIN");

  const input = registration("seed-conflict");
  expect((await post("register", input, "192.0.2.9")).statusCode).toBe(201);
  await expect(seedDemoAdmin(app.prisma, { ...config, DEMO_ADMIN_EMAIL: input.email })).rejects.toThrow("non-admin account");
  expect(await app.prisma.user.findUnique({ where: { email: input.email } })).toMatchObject({ role: "SHIPPER" });
});

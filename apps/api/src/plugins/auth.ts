import type { onRequestAsyncHookHandler, preHandlerAsyncHookHandler } from "fastify";
import fp from "fastify-plugin";
import { jwtVerify, SignJWT } from "jose";
import type { Prisma, Role } from "../generated/prisma/client.js";
import { AppError } from "../shared/errors.js";
import { isUuid } from "../shared/uuid.js";

const tokenLifetimeSeconds = 3600;
const tokenIssuer = "freightlink-api";
const tokenAudience = "freightlink-web";
const userSelect = { id: true, email: true, displayName: true, role: true, createdAt: true } satisfies Prisma.UserSelect;

export type AuthenticatedUser = Prisma.UserGetPayload<{ select: typeof userSelect }>;
export type AccessTokenClaims = { sub: string; iat: number; exp: number };
export type AuthSession = { user: AuthenticatedUser; expiresAt: number };

interface AuthService {
  signAccessToken(userId: string): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
  authenticateAccessToken(token: string): Promise<AuthSession>;
}

declare module "fastify" {
  interface FastifyInstance {
    auth: AuthService;
    authenticate: onRequestAsyncHookHandler;
    authorize: (firstRole: Role, ...otherRoles: Role[]) => preHandlerAsyncHookHandler;
  }

  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}

function unauthenticated() {
  return new AppError(401, "UNAUTHENTICATED", "A valid access token is required.");
}

export const authPlugin = fp<{ jwtSecret: string }>(async (app, { jwtSecret }) => {
  const signingKey = new TextEncoder().encode(jwtSecret);

  async function signAccessToken(userId: string) {
    if (!isUuid(userId)) throw new TypeError("The token subject must be a user UUID.");

    const issuedAt = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(userId)
      .setIssuer(tokenIssuer)
      .setAudience(tokenAudience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + tokenLifetimeSeconds)
      .sign(signingKey);
  }

  async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload: { sub, iat, exp } } = await jwtVerify(token, signingKey, {
        algorithms: ["HS256"],
        issuer: tokenIssuer,
        audience: tokenAudience,
        maxTokenAge: tokenLifetimeSeconds,
        requiredClaims: ["sub", "iat", "exp"],
      });

      if (!isUuid(sub) || iat === undefined || exp === undefined ||
          !Number.isInteger(iat) || exp !== iat + tokenLifetimeSeconds) {
        throw unauthenticated();
      }
      return { sub, iat, exp };
    } catch {
      throw unauthenticated();
    }
  }

  async function authenticateAccessToken(token: string): Promise<AuthSession> {
    const { sub, exp } = await verifyAccessToken(token);
    const user = await app.prisma.user.findUnique({ where: { id: sub }, select: userSelect });
    const expiresAt = exp * 1000;
    if (!user || expiresAt <= Date.now()) throw unauthenticated();
    return { user, expiresAt };
  }

  app.decorate("auth", { signAccessToken, verifyAccessToken, authenticateAccessToken });
  app.decorateRequest("user", null);
  app.decorate("authenticate", async (request) => {
    const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (!token) throw unauthenticated();
    request.user = (await authenticateAccessToken(token)).user;
  });
  app.decorate("authorize", (firstRole, ...otherRoles) => {
    const roles = new Set([firstRole, ...otherRoles]);
    return async (request) => {
      if (!request.user) throw unauthenticated();
      if (!roles.has(request.user.role)) {
        throw new AppError(403, "FORBIDDEN", "This action is unavailable to your role.");
      }
    };
  });
}, { name: "freightlink-auth", dependencies: ["freightlink-prisma"] });

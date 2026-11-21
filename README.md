# FreightLink

FreightLink uses a Node.js 24 npm workspace with a Next.js frontend, a Fastify API and PostgreSQL. The [Phase 0 contracts](docs/CONTEXT.md) define the business modules.

## Run the foundation

1. Copy `.env.example` to `.env`. Set a URL-safe `POSTGRES_PASSWORD` and use it in `DATABASE_URL`. Generate a local signing secret with `node -p "require('node:crypto').randomBytes(32).toString('hex')"` and set `JWT_SECRET`.
2. Run `docker compose up --build --wait`. Compose starts PostgreSQL, applies Prisma migrations before Fastify starts, then starts Next.js after the API is healthy.
3. Open `http://localhost:3000`. Fastify readiness at `http://localhost:3001/api/v1/health` performs a PostgreSQL query. Socket.IO runs at `/socket.io` on the Fastify port.

`postgres_data` persists PostgreSQL and `uploads_data` backs the API's private upload directory. Compose uses the `db` service hostname and exposes PostgreSQL to the local machine at port 5432. If a host port is occupied, set `WEB_PORT`, `API_PORT` or `POSTGRES_PORT`. Update the matching `WEB_ORIGIN`, `NEXT_PUBLIC_API_ORIGIN` or host `DATABASE_URL` as appropriate.

For host development with Node.js 24, run `npm ci`, `docker compose up -d --wait db` and `npm run db:deploy`. Run `npm run dev:api` and `npm run dev:web` in separate terminals. The API and the Prisma CLI read the root `.env`. A relative `UPLOAD_DIR` resolves from the API process's working directory. To override a public Next.js variable during host development, export it in the shell or set it in `apps/web/.env.local`. Use `npm run db:validate` and `npm run build` for local validation.

## Run tests

Run `npm test` from the workspace root for unit tests. For database integration tests, set `TEST_POSTGRES_PASSWORD` and use the same URL-safe password in `TEST_DATABASE_URL`. Keep the database and user named `freightlink_test`.

```sh
docker compose -f compose.test.yaml up -d --wait
npm run test:db
docker compose -f compose.test.yaml down
```

The test Compose stack uses a separate PostgreSQL service with temporary storage. The integration runner requires an explicit test URL, rejects the development database name as a test target, and applies migrations to the test database before running. The suite deletes only its own fixtures and closes its connections during teardown.

## Register modules

Add each business module as a Fastify plugin in [`apps/api/src/modules/index.ts`](apps/api/src/modules/index.ts). Its paths are mounted under `/api/v1`. Infrastructure already supplies `app.prisma`, `app.io` and the shared authentication plugin.

- `app.auth.signAccessToken(userId)` issues the access token. `app.auth.verifyAccessToken(token)` verifies it and returns the claims. `app.auth.authenticateAccessToken(token)` also resolves the current user in PostgreSQL and is shared with Socket.IO. Use this single token implementation in every module.
- Use `preHandler: app.authenticate` for authenticated routes. For a role check, use `preHandler: [app.authenticate, app.authorize("SHIPPER")]`. The pre-handler attaches the current public user fields to `request.user`.
- Apply `config: { rateLimit: authRateLimit }` to each future registration and login route, importing `authRateLimit` from [`plugins/rate-limit.ts`](apps/api/src/plugins/rate-limit.ts).
- Use `AppError` from [`shared/errors.ts`](apps/api/src/shared/errors.ts) for contract errors. Map operation-specific database conflicts in the module that owns the operation.
- See the [module instructions](docs/CONTEXT.md#how-to-add-a-module) for transactions, socket events, uploads, and raw webhook bytes. Frontend modules use `apiFetch`, `setAccessToken`, `connectSocket`, and `disconnectSocket` from `apps/web/src/lib`. Clear the token and disconnect the socket on logout.

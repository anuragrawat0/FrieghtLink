FROM node:24-bookworm-slim AS dependencies
WORKDIR /workspace

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY --chown=node:node apps/api/package.json apps/api/
COPY --chown=node:node apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

FROM dependencies AS api
COPY --chown=node:node apps/api/ apps/api/
RUN chown node:node apps/api && install -d -o node -g node /app/uploads
USER node
RUN npm run build --workspace @freightlink/api
EXPOSE 3001
CMD ["sh", "-c", "npm run db:deploy && exec node apps/api/dist/index.js"]

FROM dependencies AS web
ARG NEXT_PUBLIC_API_ORIGIN=http://localhost:3001
ENV NEXT_PUBLIC_API_ORIGIN=${NEXT_PUBLIC_API_ORIGIN} NEXT_TELEMETRY_DISABLED=1
COPY --chown=node:node apps/web/ apps/web/
RUN chown node:node apps/web
USER node
RUN npm run build --workspace @freightlink/web
WORKDIR /workspace/apps/web
EXPOSE 3000
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]

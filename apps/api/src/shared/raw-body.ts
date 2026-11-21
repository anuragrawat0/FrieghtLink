import { Readable } from "node:stream";
import type { preParsingHookHandler } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

// Opt in through the route's preParsing hook. Fastify still parses the original stream.
export const captureRawBody: preParsingHookHandler = (request, _reply, payload, done) => {
  const chunks: Buffer[] = [];
  const bodyLimit = request.routeOptions.bodyLimit;
  const body = Object.assign(Readable.from(copy(), { objectMode: false }), { receivedEncodedLength: 0 });

  async function* copy() {
    for await (const chunk of payload) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      body.receivedEncodedLength += bytes.length;
      if (body.receivedEncodedLength <= bodyLimit) chunks.push(bytes);
      yield bytes;
    }
    if (body.receivedEncodedLength <= bodyLimit) request.rawBody = Buffer.concat(chunks);
  }

  done(null, body);
};

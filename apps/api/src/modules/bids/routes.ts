import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { AppError, errorResponseSchema } from "../../shared/errors.js";
import { emptyObject } from "../../shared/http-schemas.js";
import { isAmountCents } from "../../shared/money.js";
import { loadParams } from "../loads/schemas.js";
import {
  acceptInput, acceptResponse, amountCents, bidDetailResponse, bidListResponse, bidParams,
  createInput, loadBidsQuery, offerInput, ownBidsQuery,
} from "./schemas.js";
import { acceptBid, counterBid, createBid, listLoadBids, listOwnBids, readBid, type BidQuery, type OfferInput } from "./service.js";

type LoadParams = { loadId: string };
type BidParams = { bidId: string };

async function validateNumericBody(request: FastifyRequest) {
  // Fastify coerces query parameters, but offer bodies require JSON numbers.
  const body = request.body as Partial<OfferInput> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || ("amountCents" in body && !isAmountCents(body.amountCents, amountCents.minimum, amountCents.maximum))
    || ("expectedRevision" in body && !Number.isSafeInteger(body.expectedRevision))) {
    throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.");
  }
}

export const bidRoutes: FastifyPluginAsync = async (app) => {
  const auth = { onRequest: app.authenticate };
  const errors = { "4xx": errorResponseSchema, "5xx": errorResponseSchema };
  const write = { ...auth, preValidation: validateNumericBody };

  app.post<{ Params: LoadParams; Body: { amountCents: number } }>("/loads/:loadId/bids", {
    ...write, preHandler: app.authorize("CARRIER"),
    schema: { params: loadParams, querystring: emptyObject, body: createInput, response: { 201: bidDetailResponse, ...errors } },
  }, async (req, reply) => reply.code(201).send({ data: await createBid(app, req.user!, req.params.loadId, req.body.amountCents) }));

  app.get<{ Params: LoadParams; Querystring: BidQuery }>("/loads/:loadId/bids", {
    ...auth, preHandler: app.authorize("SHIPPER", "ADMIN"),
    schema: { params: loadParams, querystring: loadBidsQuery, response: { 200: bidListResponse, ...errors } },
  }, async (req) => listLoadBids(app.prisma, req.user!, req.params.loadId, req.query));

  app.get<{ Querystring: BidQuery }>("/bids", {
    ...auth, preHandler: app.authorize("CARRIER"),
    schema: { querystring: ownBidsQuery, response: { 200: bidListResponse, ...errors } },
  }, async (req) => listOwnBids(app.prisma, req.user!, req.query));

  app.get<{ Params: BidParams }>("/bids/:bidId", {
    ...auth, schema: { params: bidParams, querystring: emptyObject, response: { 200: bidDetailResponse, ...errors } },
  }, async (req) => ({ data: await readBid(app.prisma, req.user!, req.params.bidId) }));

  app.post<{ Params: BidParams; Body: OfferInput }>("/bids/:bidId/offers", {
    ...write, preHandler: app.authorize("SHIPPER", "CARRIER"),
    schema: { params: bidParams, querystring: emptyObject, body: offerInput, response: { 200: bidDetailResponse, ...errors } },
  }, async (req) => ({ data: await counterBid(app, req.user!, req.params.bidId, req.body) }));

  app.post<{ Params: BidParams; Body: { expectedRevision: number } }>("/bids/:bidId/accept", {
    ...write, preHandler: app.authorize("SHIPPER"),
    schema: { params: bidParams, querystring: emptyObject, body: acceptInput, response: { 200: acceptResponse, ...errors } },
  }, async (req) => ({ data: await acceptBid(app, req.user!, req.params.bidId, req.body.expectedRevision) }));
};

import Fastify, { type FastifyInstance } from "fastify";

// Routes (prefix /api) arrive in T13.
export function buildApp(): FastifyInstance {
  return Fastify({ logger: false });
}

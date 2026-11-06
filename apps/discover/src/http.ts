import * as Discover from "@t3tools/contracts/discover";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Broker from "./Broker.ts";

const maxPayloadBytes = 64 * 1024;
const isBrokerError = Schema.is(Broker.BrokerError);
const completion = Schema.Union([
  Discover.DiscoverPairingResult.members[1],
  Discover.DiscoverPairingResult.members[2],
]);
const LinkInput = Schema.Struct({ transport: Schema.optionalKey(Discover.DiscoverTransport) });
const response = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, b3, traceparent",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });

const readBody = async (request: Request) => {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return body + decoder.decode();
      size += chunk.value.byteLength;
      if (size > maxPayloadBytes) {
        await reader.cancel();
        throw new Broker.BrokerError({ status: 413, message: "Payload too large." });
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
};

const payload = Effect.fn("DiscoverHttp.payload")(function* <
  S extends Schema.Top & { readonly DecodingServices: never },
>(request: Request, schema: S) {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return yield* new Broker.BrokerError({ status: 415, message: "JSON content type required." });
  }
  const body = yield* Effect.tryPromise({
    try: () => readBody(request),
    catch: (cause) =>
      isBrokerError(cause)
        ? cause
        : new Broker.BrokerError({ status: 400, message: "Invalid request body." }),
  });
  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
    Effect.mapError(
      () => new Broker.BrokerError({ status: 400, message: "Invalid JSON payload." }),
    ),
  );
});

export const handle = Effect.fn("DiscoverHttp.handle")(
  function* (request: Request) {
    if (request.method === "OPTIONS") return response({ ok: true });
    const pathname = new URL(request.url).pathname;
    const broker = yield* Broker.Broker;
    if (request.method === "POST" && pathname === "/api/discover/enroll") {
      return response(
        yield* broker.enroll(yield* payload(request, Discover.DiscoverEnrollmentInput)),
      );
    }
    const authorization = request.headers.get("authorization");
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
    if (!match)
      return yield* new Broker.BrokerError({
        status: 401,
        message: "Bearer authorization required.",
      });
    const token = match[1]!;
    if (pathname === "/api/discover/hosts" && request.method === "GET")
      return response(yield* broker.directory(token));
    if (pathname === "/api/discover/hosts/enroll" && request.method === "POST")
      return response(
        yield* broker.enrollHost(token, yield* payload(request, Discover.DiscoverHostRegistration)),
      );
    if (pathname === "/api/discover/hosts/heartbeat" && request.method === "POST") {
      yield* broker.heartbeat(token, yield* payload(request, Discover.DiscoverHostRegistration));
      return response({ ok: true });
    }
    if (pathname === "/api/discover/work" && request.method === "GET")
      return response(yield* broker.work(token));
    if (pathname === "/api/discover/requests" && request.method === "POST")
      return response(
        yield* broker.request(token, yield* payload(request, Discover.DiscoverPairingRequestInput)),
      );
    const servicePath = /^\/api\/discover\/services\/([a-z0-9][a-z0-9-]{0,63})\/link$/.exec(
      pathname,
    );
    if (servicePath && request.method === "GET")
      return response(yield* broker.serviceLink(token, servicePath[1]!));
    if (servicePath && request.method === "POST") {
      const input = yield* payload(request, LinkInput);
      return response(
        yield* broker.link(token, {
          serviceId: servicePath[1]!,
          ...(input.transport === undefined ? {} : { transport: input.transport }),
        }),
      );
    }
    if (servicePath && request.method === "DELETE") {
      yield* broker.unlink(token, servicePath[1]!);
      return response({ ok: true });
    }
    const resultPath = /^\/api\/discover\/requests\/([A-Za-z0-9-]{1,64})\/result$/.exec(pathname);
    if (resultPath && request.method === "GET")
      return response(yield* broker.result(token, resultPath[1]!));
    if (resultPath && request.method === "POST") {
      yield* broker.complete(token, resultPath[1]!, yield* payload(request, completion));
      return response({ ok: true });
    }
    if (pathname === "/api/discover/membership" && request.method === "DELETE") {
      yield* broker.leave(token);
      return response({ ok: true });
    }
    if (pathname === "/api/discover/hosts/enrollment" && request.method === "DELETE") {
      yield* broker.unregister(token);
      return response({ ok: true });
    }
    return response({ error: "Not found." }, 404);
  },
  Effect.catchTags({
    BrokerError: (error) => Effect.succeed(response({ error: error.message }, error.status)),
    DatabaseError: () => Effect.succeed(response({ error: "Broker storage unavailable." }, 503)),
  }),
);

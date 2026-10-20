import { Socket } from "node:net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AccountGameServerPing } from "@lucent/core/accounts";

export const ACCOUNT_SERVER_PING_CACHE_TTL_MS = 30_000;
const ACCOUNT_SERVER_PING_CONCURRENCY = 6;
const ACCOUNT_SERVER_PING_TIMEOUT_MS = 2_000;

export const AccountServerDataSchema = Schema.Struct({
  bOnline: Schema.Number,
  bUpg: Schema.Number,
  iChat: Schema.optionalKey(Schema.Number),
  iCount: Schema.Number,
  iLevel: Schema.optionalKey(Schema.Number),
  iMax: Schema.Number,
  iPort: Schema.Number,
  sIP: Schema.String,
  sLang: Schema.String,
  sName: Schema.String,
});

export type AccountServerData = typeof AccountServerDataSchema.Type;

class AccountServerConnectError extends Schema.TaggedError<AccountServerConnectError>()(
  "AccountServerConnectError",
  { cause: Schema.Defect() },
) {}

const measureTcpConnectLatency = Effect.fn("measureTcpConnectLatency")(
  function* (server: AccountServerData) {
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => new Socket()),
      (socket) =>
        Effect.sync(() => {
          socket.destroy();
          socket.removeAllListeners();
        }),
    );
    yield* Effect.callback<void, AccountServerConnectError>((resume) => {
      socket.once("connect", () => resume(Effect.void));
      const onError = (cause: unknown) =>
        resume(Effect.fail(new AccountServerConnectError({ cause })));
      socket.once("error", onError);
      try {
        socket.connect({ host: server.sIP, port: server.iPort });
        socket.unref();
      } catch (cause) {
        onError(cause);
      }
    });
  },
  Effect.scoped,
  Effect.timed,
  Effect.map(([duration]) =>
    Math.max(0, Math.round(Duration.toMillis(duration))),
  ),
  Effect.timeout(ACCOUNT_SERVER_PING_TIMEOUT_MS),
);

const pingAccountServer = Effect.fn("pingAccountServer")(function* (
  server: AccountServerData,
): Effect.fn.Return<AccountGameServerPing> {
  const serverName = server.sName;
  if (server.bOnline !== 1) {
    return { serverName, status: "offline" };
  }
  return yield* measureTcpConnectLatency(server).pipe(
    Effect.match({
      onSuccess: (latencyMs): AccountGameServerPing => ({
        latencyMs,
        serverName,
        status: "ok",
      }),
      onFailure: (error): AccountGameServerPing => ({
        serverName,
        status: error._tag === "TimeoutError" ? "timeout" : "unreachable",
      }),
    }),
  );
});

export const pingAccountServers = (servers: readonly AccountServerData[]) =>
  Effect.forEach(servers, pingAccountServer, {
    concurrency: ACCOUNT_SERVER_PING_CONCURRENCY,
  });

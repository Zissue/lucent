import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ByteSize from "effect/ByteSize";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpIncomingMessage,
} from "effect/http";

import { ACCOUNT_SERVER_REFRESH_COOLDOWN_MS } from "../../../shared/accountPolicy";
import type {
  AccountGameServer,
  AccountGameServerPingsResult,
  AccountGameServersResult,
} from "@lucent/core/accounts";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import {
  ACCOUNT_SERVER_PING_CACHE_TTL_MS,
  AccountServerDataSchema,
  pingAccountServers,
  type AccountServerData,
} from "./AccountServerPing";
import { AccountsError, accountError } from "./AccountsError";
import { getGameRequestHeaders } from "../session/GameRequestHeaders";

const SERVERS_API_URL = "https://game.aq.com/game/api/data/servers";
const SERVERS_CACHE_TTL_MS = 5 * 60 * 1_000;
const SERVER_REQUEST_TIMEOUT_MS = 10_000;

export const requestAccountServers = Effect.fn("requestAccountServers")(
  function* (
    client: HttpClient.HttpClient,
    url: string,
    headers: Record<string, string>,
  ) {
    const response = yield* HttpClient.withScope(
      HttpClient.filterStatusOk(client),
    ).get(url, { headers: { Accept: "application/json", ...headers } });
    return yield* HttpClientResponse.schemaBodyJson(
      Schema.Array(AccountServerDataSchema),
    )(response);
  },
  Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(1)),
  Effect.timeout(SERVER_REQUEST_TIMEOUT_MS),
  Effect.scoped,
);

interface AccountServerCache {
  readonly fetchedAt: number;
  readonly servers: readonly AccountServerData[];
}

const serverLoadErrorMessage = (error: unknown): string => {
  if (
    HttpClientError.isHttpClientError(error) &&
    error.reason._tag === "StatusCodeError"
  ) {
    return `Unable to load login servers (HTTP ${error.reason.response.status})`;
  }
  return error instanceof Error ? error.message : "Unable to load servers";
};

const toAccountGameServer = (server: AccountServerData): AccountGameServer => ({
  name: server.sName,
  language: server.sLang,
  online: server.bOnline === 1,
  upgrade: server.bUpg === 1,
  playerCount: server.iCount,
  maxPlayers: server.iMax,
});

export interface AccountServersShape {
  readonly get: Effect.Effect<AccountGameServersResult, AccountsError>;
  readonly getPings: Effect.Effect<AccountGameServerPingsResult, AccountsError>;
  readonly refresh: Effect.Effect<AccountGameServersResult, AccountsError>;
}

export class AccountServers extends Context.Service<
  AccountServers,
  AccountServersShape
>()("lucent/desktop/game/accounts/AccountServers") {}

export const layer = Layer.effect(
  AccountServers,
  Effect.gen(function* () {
    const env = yield* DesktopEnvironment;
    const client = yield* HttpClient.HttpClient;
    const requestHeaders = getGameRequestHeaders(env.platform);
    const serverLoads = yield* Semaphore.make(1);
    const pingLoads = yield* Semaphore.make(1);
    let serverCache: AccountServerCache | null = null;
    let lastRefreshRequestTime: number | null = null;

    const pingCache = yield* Cache.make({
      lookup: Effect.fn("AccountServers.measurePings")(function* (
        servers: readonly AccountServerData[],
      ) {
        const pings = yield* pingAccountServers(servers).pipe(
          pingLoads.withPermits(1),
        );
        const measuredAt = yield* Clock.currentTimeMillis;
        return {
          expiresAt: measuredAt + ACCOUNT_SERVER_PING_CACHE_TTL_MS,
          measuredAt,
          pings,
        } satisfies AccountGameServerPingsResult;
      }),
      capacity: 1,
      timeToLive: ACCOUNT_SERVER_PING_CACHE_TTL_MS,
    });

    const getCachedServers = serverLoads.withPermits(1)(
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis;
        if (
          serverCache !== null &&
          timestamp - serverCache.fetchedAt < SERVERS_CACHE_TTL_MS
        ) {
          return serverCache.servers;
        }

        const servers = yield* requestAccountServers(
          client,
          SERVERS_API_URL,
          requestHeaders,
        ).pipe(
          Effect.mapError((cause) =>
            accountError(
              "refresh-servers",
              cause._tag === "SchemaError"
                ? "Invalid login servers payload"
                : serverLoadErrorMessage(cause),
              cause,
            ),
          ),
          Effect.catch((error: AccountsError) =>
            serverCache === null
              ? Effect.fail(error)
              : Effect.logWarning(
                  "Failed to fetch servers; using cache",
                  Cause.fail(error),
                )
                  .pipe(
                    Effect.annotateLogs({
                      component: "accounts",
                      data: {
                        cachedServerCount: serverCache.servers.length,
                      },
                    }),
                  )
                  .pipe(Effect.as(serverCache.servers)),
          ),
        );

        serverCache = { fetchedAt: yield* Clock.currentTimeMillis, servers };
        yield* Cache.invalidateAll(pingCache);
        return servers;
      }),
    );

    const toResult = (
      servers: readonly AccountServerData[],
    ): AccountGameServersResult => ({
      servers: servers.map(toAccountGameServer),
      refreshAvailableAt:
        lastRefreshRequestTime === null
          ? 0
          : lastRefreshRequestTime + ACCOUNT_SERVER_REFRESH_COOLDOWN_MS,
    });

    const get: AccountServersShape["get"] = getCachedServers.pipe(
      Effect.map(toResult),
    );

    const getPings: AccountServersShape["getPings"] = getCachedServers.pipe(
      Effect.flatMap((servers) => Cache.get(pingCache, servers)),
    );

    const refresh: AccountServersShape["refresh"] = Effect.gen(function* () {
      const timestamp = yield* Clock.currentTimeMillis;
      if (
        lastRefreshRequestTime !== null &&
        timestamp - lastRefreshRequestTime < ACCOUNT_SERVER_REFRESH_COOLDOWN_MS
      ) {
        return yield* get;
      }

      lastRefreshRequestTime = timestamp;
      serverCache = null;
      yield* Cache.invalidateAll(pingCache);
      return toResult(yield* getCachedServers);
    });

    return AccountServers.of({ get, getPings, refresh });
  }),
);

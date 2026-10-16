import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as EffectNumber from "effect/Number";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as FiberMapType from "effect/FiberMap";

import type { ApiService } from "../flash/api/Api";

export interface AutoReloginApi {
  readonly auth: Pick<
    ApiService["auth"],
    | "connectTo"
    | "getPassword"
    | "getServers"
    | "getUsername"
    | "isLoggedIn"
    | "isServerSelectReady"
    | "isTemporarilyKicked"
    | "login"
    | "logout"
  >;
  readonly events: Pick<ApiService["events"], "on" | "once">;
  readonly player: Pick<ApiService["player"], "isReady">;
}

export interface AutoReloginState {
  readonly attemptsRemaining?: number;
  readonly attempting: boolean;
  readonly captured: boolean;
  readonly delayMs: number;
  readonly enabled: boolean;
  readonly lastError?: string;
  readonly server?: string;
  readonly username?: string;
  readonly waitingDelay: boolean;
}

export type AutoReloginLifecycleStep = "connect" | "login" | "ready";
export interface AutoReloginLifecycleEvent {
  readonly attemptsRemaining: number;
  readonly message?: string;
  readonly step: AutoReloginLifecycleStep;
}
export interface AutoReloginLoginRequest {
  readonly onLifecycle?: (
    event: AutoReloginLifecycleEvent,
  ) => Effect.Effect<void, unknown>;
  readonly password: string;
  readonly server?: string;
  readonly username: string;
}
export type AutoReloginLoginResult =
  | { readonly status: "ready" }
  | { readonly status: "server-select" };

export class AutoReloginLoginError extends Data.TaggedError(
  "AutoReloginLoginError",
)<{ readonly detail: string }> {
  override get message(): string {
    return this.detail;
  }
}

type ReloginPhase =
  | { readonly tag: "armed" }
  | { readonly tag: "awaiting-session" }
  | { readonly tag: "awaiting-player-ready" }
  | { readonly tag: "awaiting-server-select" }
  | { readonly delayMs: number; readonly tag: "backoff" }
  | { readonly tag: "failed" }
  | { readonly tag: "logging-in" }
  | { readonly tag: "selecting-server" }
  | { readonly tag: "waiting-delay" }
  | { readonly tag: "waiting-kick" };

interface State {
  attemptsRemaining: number | undefined;
  delayMs: number;
  enabled: boolean;
  generation: number;
  lastError: string | undefined;
  password: string | undefined;
  phase: ReloginPhase;
  server: string | undefined;
  username: string | undefined;
}

class AutoReloginAttemptError extends Data.TaggedError(
  "AutoReloginAttemptError",
)<{
  readonly attemptsRemaining: number;
  readonly detail: string;
  readonly retryable: boolean;
  readonly step: AutoReloginLifecycleStep;
}> {}

interface LoginObserver {
  readonly attemptStarted: (
    attemptIndex: number,
    attemptsRemaining: number,
  ) => Effect.Effect<void>;
  readonly backoff: (delayMs: number) => Effect.Effect<void>;
  readonly failure: (error: AutoReloginAttemptError) => Effect.Effect<void>;
  readonly phase: (phase: ReloginPhase) => Effect.Effect<void>;
}

const backgroundKey = "auto-relogin";
const captureWatcherKey = "auto-relogin-capture";
const readyWatcherKey = "auto-relogin-ready";
const captureInterval = "5 seconds";
const maximumRetries = 3;
const defaultDelay = 3_000;
const readinessPollInterval = "500 millis";
const playerReadyTimeout = "10 seconds";
const serverSelectTimeout = "15 seconds";

const noopObserver: LoginObserver = {
  attemptStarted: () => Effect.void,
  backoff: () => Effect.void,
  failure: () => Effect.void,
  phase: () => Effect.void,
};

export const normalizeAutoReloginDelay = (delayMs: number): number =>
  Number.isFinite(delayMs)
    ? EffectNumber.clamp({ minimum: 0, maximum: 300_000 })(delayMs)
    : defaultDelay;

const normalizeAutoReloginServer = (
  server: string | undefined,
  servers: readonly { readonly name: string }[],
): string | undefined => {
  if (server === undefined) return undefined;
  const requested = server.trim();
  if (requested === "") return "";

  return (
    servers.find(
      ({ name }) =>
        name.localeCompare(requested, undefined, { sensitivity: "accent" }) ===
        0,
    )?.name ?? requested
  );
};

const attemptingPhases = new Set<ReloginPhase["tag"]>([
  "awaiting-player-ready",
  "awaiting-server-select",
  "backoff",
  "logging-in",
  "selecting-server",
]);

const publicState = (state: State): AutoReloginState => ({
  attempting: attemptingPhases.has(state.phase.tag),
  captured: state.username !== undefined && state.password !== undefined,
  delayMs: state.delayMs,
  enabled: state.enabled,
  waitingDelay:
    state.phase.tag === "waiting-delay" || state.phase.tag === "waiting-kick",
  ...(state.attemptsRemaining === undefined
    ? {}
    : { attemptsRemaining: state.attemptsRemaining }),
  ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
  ...(state.server === undefined ? {} : { server: state.server }),
  ...(state.username === undefined ? {} : { username: state.username }),
});

const formatErrorDetail = (detail: string): string => {
  const trimmed = detail.trim();
  if (trimmed === "") return "Auto relogin failed.";
  const sentence = `${trimmed[0]!.toLocaleUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
};

const lifecycle = (
  request: AutoReloginLoginRequest,
  step: AutoReloginLifecycleStep,
  attemptsRemaining: number,
  message?: string,
) =>
  request
    .onLifecycle?.({
      attemptsRemaining,
      step,
      ...(message === undefined ? {} : { message }),
    })
    .pipe(Effect.catchCause(() => Effect.void)) ?? Effect.void;

export const makeAutoRelogin = Effect.fnUntraced(function* (
  api: AutoReloginApi,
  fibers: FiberMapType.FiberMap<string>,
) {
  const state = yield* SubscriptionRef.make<State>({
    attemptsRemaining: undefined,
    delayMs: defaultDelay,
    enabled: false,
    generation: 0,
    lastError: undefined,
    password: undefined,
    phase: { tag: "armed" },
    server: undefined,
    username: undefined,
  });
  const loginPermit = yield* Semaphore.make(1);
  const explicitRuns = yield* Ref.make(0);

  const getState = () =>
    SubscriptionRef.get(state).pipe(Effect.map(publicState));
  const changes = SubscriptionRef.changes(state).pipe(Stream.map(publicState));

  const isPlayerReady = () =>
    api.player.isReady().pipe(Effect.catchCause(() => Effect.succeed(false)));

  const waitUntilPlayerReady = () =>
    Effect.repeat(isPlayerReady(), {
      schedule: Schedule.spaced(readinessPollInterval),
      until: Boolean,
    }).pipe(Effect.asVoid);

  const waitForPlayerReady = () =>
    waitUntilPlayerReady().pipe(
      Effect.timeoutOption(playerReadyTimeout),
      Effect.map(Option.isSome),
    );

  const racePlayerReady = <A>(effect: Effect.Effect<A>) =>
    Effect.race(
      effect.pipe(
        Effect.map((value) => ({ tag: "completed" as const, value })),
      ),
      waitUntilPlayerReady().pipe(Effect.as({ tag: "ready" as const })),
    );

  const updateCurrentGeneration = (
    generation: number,
    update: (current: State) => State,
  ) =>
    SubscriptionRef.update(state, (current) =>
      current.enabled && current.generation === generation
        ? update(current)
        : current,
    );

  const captureIfMissing = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (!current.enabled) return true;
    if (current.username !== undefined && current.password !== undefined) {
      return true;
    }

    const markAwaitingSession = SubscriptionRef.update(
      state,
      (latest): State =>
        latest.enabled &&
        (latest.username === undefined || latest.password === undefined) &&
        (latest.phase.tag !== "awaiting-session" ||
          latest.attemptsRemaining !== undefined ||
          latest.lastError !== undefined)
          ? {
              ...latest,
              attemptsRemaining: undefined,
              lastError: undefined,
              phase: { tag: "awaiting-session" },
            }
          : latest,
    );

    const username = (yield* api.auth.getUsername()).trim();
    if (username === "") {
      yield* markAwaitingSession;
      return false;
    }

    const password = yield* api.auth.getPassword();
    if (password === "") {
      yield* markAwaitingSession;
      return false;
    }

    yield* SubscriptionRef.update(
      state,
      (latest): State =>
        latest.enabled &&
        (latest.username === undefined || latest.password === undefined)
          ? {
              ...latest,
              attemptsRemaining: undefined,
              lastError: undefined,
              password,
              phase: { tag: "armed" },
              username,
            }
          : latest,
    );
    return true;
  });

  const watchForCapturableSession = () =>
    FiberMap.run(
      fibers,
      captureWatcherKey,
      Effect.sleep(captureInterval).pipe(
        Effect.andThen(
          Effect.repeat(captureIfMissing, {
            schedule: Schedule.spaced(captureInterval),
            until: (captured) => captured,
          }),
        ),
        Effect.asVoid,
      ),
    ).pipe(Effect.asVoid);

  const markReadySuccess = Effect.gen(function* () {
    if (!(yield* isPlayerReady())) return false;
    yield* captureIfMissing;
    yield* SubscriptionRef.update(
      state,
      (current): State =>
        current.enabled
          ? {
              ...current,
              attemptsRemaining: undefined,
              generation: current.generation + 1,
              lastError: undefined,
              phase: { tag: "armed" },
            }
          : current,
    );
    return true;
  });

  const failAttempt = (
    detail: string,
    retryable: boolean,
    step: AutoReloginLifecycleStep,
    attemptsRemaining: number,
  ) =>
    Effect.fail(
      new AutoReloginAttemptError({
        attemptsRemaining,
        detail: formatErrorDetail(detail),
        retryable,
        step,
      }),
    );

  const waitForLoginOutcome = () => {
    const readOutcome = Effect.gen(function* () {
      if (yield* isPlayerReady()) return Option.some("ready" as const);
      if (yield* api.auth.isLoggedIn()) {
        return Option.some("connected" as const);
      }
      if (yield* api.auth.isServerSelectReady()) {
        return Option.some("server-select" as const);
      }
      return Option.none<"connected" | "ready" | "server-select">();
    });

    return Effect.repeat(readOutcome, {
      schedule: Schedule.spaced(readinessPollInterval),
      until: Option.isSome,
    }).pipe(
      Effect.timeoutOption(serverSelectTimeout),
      Effect.map(Option.flatten),
      Effect.map(Option.getOrNull),
    );
  };

  // Background recovery resolves its target lazily so edits preserve phase and retries.
  const orchestrateLogin = (
    request: AutoReloginLoginRequest,
    observer: LoginObserver = noopObserver,
    resolveServer: Effect.Effect<string | undefined> = Effect.succeed(
      request.server?.trim() || undefined,
    ),
    resumeAtServerSelect = false,
  ): Effect.Effect<AutoReloginLoginResult, AutoReloginAttemptError> => {
    let requiresFreshServerList = false;
    const completePlayerConnection = (attemptsRemaining: number) =>
      Effect.gen(function* () {
        yield* observer.phase({ tag: "awaiting-player-ready" });
        yield* lifecycle(request, "ready", attemptsRemaining);
        if (yield* waitForPlayerReady()) {
          return { status: "ready" as const };
        }
        // Recheck at the timeout boundary before a retry logs the player out.
        if (yield* isPlayerReady()) return { status: "ready" as const };
        yield* api.auth.logout();
        return yield* failAttempt(
          "Player did not become ready",
          true,
          "ready",
          attemptsRemaining,
        );
      });

    const attempt = Effect.gen(function* () {
      const metadata = yield* Schedule.CurrentMetadata;
      const attemptIndex = Math.min(maximumRetries, metadata.attempt);
      const attemptsRemaining = Math.max(0, maximumRetries - attemptIndex);
      yield* observer.attemptStarted(attemptIndex, attemptsRemaining);

      if (yield* isPlayerReady()) return { status: "ready" as const };
      if (request.username.trim() === "" || request.password === "") {
        return yield* failAttempt(
          "Username and password are required",
          false,
          "login",
          attemptsRemaining,
        );
      }

      let loginOutcome: "connected" | "ready" | "server-select" | null;
      if (
        !requiresFreshServerList &&
        (attemptIndex > 0 || resumeAtServerSelect) &&
        (yield* api.auth.isServerSelectReady())
      ) {
        loginOutcome = "server-select";
      } else {
        const temporarilyKicked = yield* api.auth.isTemporarilyKicked();
        if (temporarilyKicked) {
          yield* observer.phase({ tag: "waiting-kick" });
          yield* lifecycle(
            request,
            "login",
            attemptsRemaining,
            "Waiting for the temporary login restriction to clear",
          );
        } else {
          yield* observer.phase({ tag: "logging-in" });
          yield* lifecycle(request, "login", attemptsRemaining);
        }

        if (yield* isPlayerReady()) return { status: "ready" as const };
        const login = yield* racePlayerReady(
          api.auth.login(request.username, request.password),
        );
        if (login.tag === "ready") return { status: "ready" as const };
        const submitted = login.value;
        if (temporarilyKicked) {
          yield* observer.phase({ tag: "logging-in" });
          yield* lifecycle(request, "login", attemptsRemaining);
        }
        if (yield* isPlayerReady()) return { status: "ready" as const };
        if (!submitted) {
          return yield* failAttempt(
            "Login could not be submitted",
            true,
            "login",
            attemptsRemaining,
          );
        }

        yield* observer.phase({ tag: "awaiting-server-select" });
        loginOutcome = yield* waitForLoginOutcome();
        if (loginOutcome === "server-select") requiresFreshServerList = false;
      }
      if (loginOutcome === "ready") return { status: "ready" as const };
      if (loginOutcome === "connected") {
        return yield* completePlayerConnection(attemptsRemaining);
      }
      if (loginOutcome === null) {
        return yield* failAttempt(
          "Login did not reach server selection",
          true,
          "login",
          attemptsRemaining,
        );
      }
      let server = yield* resolveServer;
      if (server === undefined) return { status: "server-select" as const };

      if (yield* isPlayerReady()) return { status: "ready" as const };
      if (yield* api.auth.isLoggedIn()) {
        return yield* completePlayerConnection(attemptsRemaining);
      }

      const manualConnection = yield* api.events.once(
        { type: "connection" },
        { timeout: "250 millis" },
      );
      if (
        manualConnection?.type === "connection" &&
        manualConnection.status === "OnConnection"
      ) {
        return yield* completePlayerConnection(attemptsRemaining);
      }
      if (yield* isPlayerReady()) return { status: "ready" as const };
      if (yield* api.auth.isLoggedIn()) {
        return yield* completePlayerConnection(attemptsRemaining);
      }

      server = yield* resolveServer;
      if (server === undefined) return { status: "server-select" as const };
      yield* observer.phase({ tag: "selecting-server" });
      yield* lifecycle(request, "connect", attemptsRemaining);
      const selection = yield* racePlayerReady(api.auth.connectTo(server));
      if (selection.tag === "ready") return { status: "ready" as const };
      const selected = selection.value;
      if (selected.status !== "connected") {
        if (yield* isPlayerReady()) return { status: "ready" as const };
        if (yield* api.auth.isLoggedIn()) {
          return yield* completePlayerConnection(attemptsRemaining);
        }
        if (selected.status === "full") {
          // A fresh login reloads AQW's server list before the scheduled retry.
          requiresFreshServerList = true;
          yield* api.auth.logout();
        }
        return yield* failAttempt(
          selected.message,
          selected.retryable,
          "connect",
          attemptsRemaining,
        );
      }

      return yield* completePlayerConnection(attemptsRemaining);
    });

    const reportRetryableFailure = (error: AutoReloginAttemptError) =>
      error.retryable
        ? observer
            .failure(error)
            .pipe(
              Effect.andThen(
                lifecycle(
                  request,
                  error.step,
                  error.attemptsRemaining,
                  error.detail,
                ),
              ),
            )
        : Effect.void;

    const retrySchedule = Schedule.exponential("5 seconds").pipe(
      Schedule.upTo({ times: maximumRetries }),
      Schedule.setInputType<AutoReloginAttemptError>(),
      Schedule.tap(({ output: delay }) =>
        observer.backoff(Duration.toMillis(delay)),
      ),
    );

    return attempt.pipe(
      Effect.tapError(reportRetryableFailure),
      Effect.retry({
        schedule: retrySchedule,
        while: (error) => error.retryable,
      }),
    );
  };

  const backgroundObserver = (generation: number): LoginObserver => ({
    attemptStarted: (_attemptIndex, attemptsRemaining) =>
      updateCurrentGeneration(generation, (current) => ({
        ...current,
        attemptsRemaining,
        lastError: undefined,
      })),
    backoff: (delayMs) =>
      updateCurrentGeneration(generation, (current) => ({
        ...current,
        phase: { delayMs, tag: "backoff" },
      })),
    failure: (error) =>
      updateCurrentGeneration(generation, (current) => ({
        ...current,
        attemptsRemaining: error.attemptsRemaining,
        lastError: error.detail,
      })),
    phase: (phase) =>
      updateCurrentGeneration(generation, (current) => ({
        ...current,
        phase,
      })),
  });

  const resolveBackgroundServer = (generation: number) =>
    SubscriptionRef.get(state).pipe(
      Effect.map((current) =>
        current.enabled && current.generation === generation
          ? current.server
          : undefined,
      ),
    );

  const waitForRecoveryDelay = (
    generation: number,
    startedAt: number,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      // Delay edits retain time already elapsed since the disconnect.
      while (true) {
        const current = yield* SubscriptionRef.get(state);
        if (!current.enabled || current.generation !== generation) return false;

        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        const remaining = Math.max(0, current.delayMs - elapsed);
        if (remaining === 0) return true;

        const observedDelay = current.delayMs;
        const outcome = yield* Effect.race(
          Effect.sleep(`${remaining} millis`).pipe(
            Effect.as("elapsed" as const),
          ),
          SubscriptionRef.changes(state).pipe(
            Stream.filter(
              (next) =>
                !next.enabled ||
                next.generation !== generation ||
                next.delayMs !== observedDelay,
            ),
            Stream.runHead,
            Effect.as("changed" as const),
          ),
        );
        if (outcome === "elapsed") return true;
      }
    });

  const runBackground = (
    generation: number,
    startedAt: number,
    skipDelay: boolean,
    resumeAtServerSelect: boolean,
  ) =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      if (
        !current.enabled ||
        current.generation !== generation ||
        current.username === undefined ||
        current.password === undefined
      ) {
        return;
      }

      yield* updateCurrentGeneration(generation, (latest) => ({
        ...latest,
        attemptsRemaining: undefined,
        lastError: undefined,
        phase: { tag: "waiting-delay" },
      }));
      if (!skipDelay && !(yield* waitForRecoveryDelay(generation, startedAt))) {
        return;
      }

      if (yield* isPlayerReady()) {
        yield* markReadySuccess;
        return;
      }
      const latest = yield* SubscriptionRef.get(state);
      if (!latest.enabled || latest.generation !== generation) return;

      const result = yield* Effect.result(
        loginPermit.withPermits(1)(
          orchestrateLogin(
            {
              password: current.password,
              username: current.username,
            },
            backgroundObserver(generation),
            resolveBackgroundServer(generation),
            resumeAtServerSelect,
          ),
        ),
      );

      if (Result.isSuccess(result)) {
        yield* updateCurrentGeneration(generation, (value) => ({
          ...value,
          attemptsRemaining: undefined,
          lastError: undefined,
          phase: { tag: "armed" },
        }));
        return;
      }

      const failure = result.failure;
      yield* updateCurrentGeneration(generation, (value) => ({
        ...value,
        attemptsRemaining: failure.retryable ? 0 : undefined,
        lastError: failure.detail,
        phase: { tag: "failed" },
      }));
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("Unexpected auto relogin failure", cause).pipe(
              Effect.annotateLogs({ component: "auto-relogin" }),
              Effect.andThen(
                updateCurrentGeneration(generation, (current) => ({
                  ...current,
                  attemptsRemaining: undefined,
                  lastError: "Auto relogin failed unexpectedly.",
                  phase: { tag: "failed" },
                })),
              ),
            ),
      ),
    );

  const startRecovery = (skipDelay = false, resumeAtServerSelect = false) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(explicitRuns)) > 0) return;
      const startedAt = yield* Clock.currentTimeMillis;
      const generation = yield* SubscriptionRef.modify(state, (current) => {
        if (
          !current.enabled ||
          current.username === undefined ||
          current.password === undefined ||
          current.phase.tag === "failed"
        ) {
          return [undefined, current] as const;
        }
        const nextGeneration = current.generation + 1;
        return [
          nextGeneration,
          {
            ...current,
            generation: nextGeneration,
            phase: { tag: "waiting-delay" },
          },
        ] as const;
      });
      if (generation === undefined) return;
      yield* FiberMap.run(
        fibers,
        backgroundKey,
        runBackground(generation, startedAt, skipDelay, resumeAtServerSelect),
      );
    });

  const watchForReady = () =>
    FiberMap.run(
      fibers,
      readyWatcherKey,
      waitForPlayerReady().pipe(
        Effect.flatMap((ready) =>
          ready
            ? FiberMap.remove(fibers, backgroundKey).pipe(
                Effect.andThen(markReadySuccess),
              )
            : Effect.void,
        ),
        Effect.asVoid,
      ),
    ).pipe(Effect.asVoid);

  const runLogin = (
    request: AutoReloginLoginRequest,
  ): Effect.Effect<AutoReloginLoginResult, AutoReloginLoginError> =>
    Effect.acquireUseRelease(
      Ref.update(explicitRuns, (count) => count + 1),
      () =>
        Effect.gen(function* () {
          yield* FiberMap.remove(fibers, backgroundKey);
          yield* SubscriptionRef.update(
            state,
            (current): State =>
              current.enabled
                ? {
                    ...current,
                    attemptsRemaining: undefined,
                    generation: current.generation + 1,
                    lastError: undefined,
                    phase: { tag: "armed" },
                  }
                : current,
          );
          return yield* loginPermit.withPermits(1)(orchestrateLogin(request));
        }),
      () => Ref.update(explicitRuns, (count) => count - 1),
    ).pipe(
      Effect.mapError(
        (error) =>
          new AutoReloginLoginError({
            detail: error.detail,
          }),
      ),
    );

  const stop = () =>
    Effect.gen(function* () {
      yield* FiberMap.remove(fibers, backgroundKey);
      yield* FiberMap.remove(fibers, captureWatcherKey);
      yield* FiberMap.remove(fibers, readyWatcherKey);
      yield* SubscriptionRef.update(
        state,
        (current): State => ({
          ...current,
          attemptsRemaining: undefined,
          enabled: false,
          generation: current.generation + 1,
          lastError: undefined,
          password: undefined,
          phase: { tag: "armed" },
          username: undefined,
        }),
      );
      return yield* getState();
    });

  const start = () =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      if (!current.enabled) {
        yield* SubscriptionRef.update(
          state,
          (value): State => ({
            ...value,
            attemptsRemaining: undefined,
            enabled: true,
            generation: value.generation + 1,
            lastError: undefined,
            phase: { tag: "armed" },
          }),
        );
      }

      yield* captureIfMissing;
      if (yield* isPlayerReady()) {
        yield* markReadySuccess;
      } else {
        const latest = yield* SubscriptionRef.get(state);
        if (latest.username === undefined || latest.password === undefined) {
          yield* watchForCapturableSession();
        }
      }
      return yield* getState();
    });

  const getDelayMs = () =>
    SubscriptionRef.get(state).pipe(Effect.map((current) => current.delayMs));
  const getServer = () =>
    SubscriptionRef.get(state).pipe(Effect.map((current) => current.server));
  const isEnabled = () =>
    SubscriptionRef.get(state).pipe(Effect.map((current) => current.enabled));

  const reconfigure = (update: (current: State) => State) =>
    Effect.gen(function* () {
      yield* SubscriptionRef.update(state, update);
      const current = yield* SubscriptionRef.get(state);
      if (
        current.enabled &&
        (current.username === undefined || current.password === undefined)
      ) {
        yield* watchForCapturableSession();
      }
      return yield* getState();
    });

  const setDelay = (delay: Duration.Input) =>
    reconfigure((current) => ({
      ...current,
      delayMs: normalizeAutoReloginDelay(Duration.toMillis(delay)),
    }));
  const setEnabled = (enabled: boolean) => (enabled ? start() : stop());
  const setServer = (server: string | undefined) =>
    Effect.gen(function* () {
      const servers =
        server === undefined || server.trim() === ""
          ? []
          : yield* api.auth.getServers();
      const nextServer = normalizeAutoReloginServer(server, servers);
      const shouldRetry = yield* SubscriptionRef.modify(state, (current) => {
        const changed = current.server !== nextServer;
        // A different target after failure is fresh user intent, so retry now.
        const retry =
          changed &&
          current.enabled &&
          current.phase.tag === "failed" &&
          current.username !== undefined &&
          current.password !== undefined;
        return [
          retry,
          {
            ...current,
            ...(retry
              ? {
                  attemptsRemaining: undefined,
                  lastError: undefined,
                  phase: { tag: "armed" } as const,
                }
              : changed
                ? { lastError: undefined }
                : {}),
            server: nextServer,
          },
        ] as const;
      });
      if (shouldRetry && !(yield* isPlayerReady())) {
        yield* startRecovery(true, true);
      }
      const current = yield* SubscriptionRef.get(state);
      if (
        current.enabled &&
        (current.username === undefined || current.password === undefined)
      ) {
        yield* watchForCapturableSession();
      }
      return yield* getState();
    });

  const disposeConnection = yield* api.events.on(
    { type: "connection" },
    (event) => {
      if (event.type !== "connection") return Effect.void;
      if (
        event.status === "OnConnectionLost" ||
        event.status === "OnConnectionFailed"
      ) {
        return Effect.gen(function* () {
          yield* FiberMap.remove(fibers, readyWatcherKey);
          if (
            (yield* Ref.get(explicitRuns)) > 0 ||
            (yield* FiberMap.has(fibers, backgroundKey))
          ) {
            return;
          }
          yield* startRecovery();
        });
      }
      if (event.status === "OnConnection") {
        // isReady is a query; connection starts the bounded readiness watcher.
        return captureIfMissing.pipe(Effect.andThen(watchForReady()));
      }
      return Effect.void;
    },
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      disposeConnection();
    }),
  );

  return {
    changes,
    getDelayMs,
    getServer,
    getState,
    isEnabled,
    runLogin,
    setDelay,
    setEnabled,
    setServer,
  };
});

export type AutoRelogin = Effect.Success<ReturnType<typeof makeAutoRelogin>>;

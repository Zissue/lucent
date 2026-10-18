import * as Effect from "effect/Effect";

import { ArmyIpc } from "../../../shared/ipc";
import {
  ArmyConfigRepository,
  type ArmyConfigRepositoryError,
} from "../../game/army/ArmyConfigRepository";
import { ArmyCoordinator } from "../../game/army/ArmyCoordinator";
import type { ArmyCoordinatorError } from "../../game/army/ArmySession";
import {
  ArmyLoopTauntOrchestrator,
  type ArmyLoopTauntOrchestratorError,
} from "../../game/army/ArmyLoopTauntOrchestrator";
import { DesktopWindows } from "../../window/DesktopWindows";
import {
  DesktopIpc,
  type DesktopIpcMethodRegistration,
  makeDesktopIpcMethod,
} from "../DesktopIpc";

const gameSenders = ["game"] as const;

export const loadConfig = makeDesktopIpcMethod({
  descriptor: ArmyIpc.loadConfig,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.loadConfig")(function* (payload) {
    const configs = yield* ArmyConfigRepository;
    return yield* configs.read(payload.configName);
  }),
});

export const start = makeDesktopIpcMethod({
  descriptor: ArmyIpc.start,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.start")(function* (payload, sender) {
    const configs = yield* ArmyConfigRepository;
    const coordinator = yield* ArmyCoordinator;
    const config = yield* configs.read(payload.configName);
    return yield* coordinator.join(config, payload.playerName, sender.lifetime);
  }),
});

export const leave = makeDesktopIpcMethod({
  descriptor: ArmyIpc.leave,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.leave")(function* (_payload, sender) {
    const coordinator = yield* ArmyCoordinator;
    return yield* coordinator.leave(sender.rendererId);
  }),
});

export const sync = makeDesktopIpcMethod({
  descriptor: ArmyIpc.sync,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.sync")(function* (payload, sender) {
    const coordinator = yield* ArmyCoordinator;
    return yield* coordinator.sync(
      payload.sessionId,
      sender.rendererId,
      payload,
    );
  }),
});

export const progress = makeDesktopIpcMethod({
  descriptor: ArmyIpc.progress,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.progress")(function* (payload, sender) {
    const coordinator = yield* ArmyCoordinator;
    return yield* coordinator.progress(
      payload.sessionId,
      sender.rendererId,
      payload,
    );
  }),
});

export const fail = makeDesktopIpcMethod({
  descriptor: ArmyIpc.fail,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.fail")(function* (payload, sender) {
    const coordinator = yield* ArmyCoordinator;
    return yield* coordinator.fail(
      payload.sessionId,
      sender.rendererId,
      payload.reason,
    );
  }),
});

export const loopTauntRegister = makeDesktopIpcMethod({
  descriptor: ArmyIpc.loopTauntRegister,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.loopTauntRegister")(
    function* (payload, sender) {
      const orchestrator = yield* ArmyLoopTauntOrchestrator;
      return yield* orchestrator.register(payload, sender.rendererId);
    },
  ),
});

export const loopTauntAwait = makeDesktopIpcMethod({
  descriptor: ArmyIpc.loopTauntAwait,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.loopTauntAwait")(
    function* (payload, sender) {
      const orchestrator = yield* ArmyLoopTauntOrchestrator;
      return yield* orchestrator.await(payload, sender.rendererId);
    },
  ),
});

export const loopTauntReady = makeDesktopIpcMethod({
  descriptor: ArmyIpc.loopTauntReady,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.loopTauntReady")(
    function* (payload, sender) {
      const orchestrator = yield* ArmyLoopTauntOrchestrator;
      return yield* orchestrator.ready(payload, sender.rendererId);
    },
  ),
});

export const loopTauntReport = makeDesktopIpcMethod({
  descriptor: ArmyIpc.loopTauntReport,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.loopTauntReport")(
    function* (payload, sender) {
      const orchestrator = yield* ArmyLoopTauntOrchestrator;
      return yield* orchestrator.report(payload, sender.rendererId);
    },
  ),
});

export const loopTauntLeave = makeDesktopIpcMethod({
  descriptor: ArmyIpc.loopTauntLeave,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.army.loopTauntLeave")(
    function* (payload, sender) {
      const orchestrator = yield* ArmyLoopTauntOrchestrator;
      return yield* orchestrator.leave(payload, sender.rendererId);
    },
  ),
});

type ArmyIpcMethod = DesktopIpcMethodRegistration<
  | ArmyConfigRepositoryError
  | ArmyCoordinatorError
  | ArmyLoopTauntOrchestratorError,
  ArmyConfigRepository | ArmyCoordinator | ArmyLoopTauntOrchestrator
>;

export const methods: readonly ArmyIpcMethod[] = [
  loadConfig,
  start,
  leave,
  sync,
  progress,
  fail,
  loopTauntRegister,
  loopTauntReady,
  loopTauntAwait,
  loopTauntReport,
  loopTauntLeave,
];

export const installLifecycle = Effect.fn("desktop.ipc.army.installLifecycle")(
  function* () {
    const coordinator = yield* ArmyCoordinator;
    const loopTauntOrchestrator = yield* ArmyLoopTauntOrchestrator;
    const ipc = yield* DesktopIpc;
    const windows = yield* DesktopWindows;

    yield* Effect.acquireRelease(
      loopTauntOrchestrator.onCommand((event) =>
        ipc.sendToRendererIds(
          event.participantIds,
          ArmyIpc.loopTauntCommand,
          event.command,
        ),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    yield* Effect.acquireRelease(
      coordinator.onSessionEnded((event) =>
        ipc.sendToRendererIds(event.participantIds, ArmyIpc.ended, {
          reason: event.reason,
          sessionId: event.sessionId,
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    yield* windows.observe({ kind: "game" }, (event) => {
      switch (event.type) {
        case "crashed":
        case "reloaded":
        case "closed":
          return coordinator.abortParticipant(event.rendererId, {
            kind: "participant-unavailable",
            reason:
              event.type === "crashed"
                ? "An army player's game stopped unexpectedly"
                : event.type === "reloaded"
                  ? "An army player's game reloaded"
                  : "Army window closed",
          });
        default:
          return Effect.void;
      }
    });
  },
);

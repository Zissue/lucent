import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { PacketsError, PacketsRpcs } from "../../../shared/gameRendererRpc";
import type {
  PacketQueuePayload,
  PacketSendPayload,
  PacketSendTarget,
} from "../../../shared/packets";
import type { DesktopGamePacketsBridge } from "../../../shared/desktopBridge";
import { Api } from "./flash";
import type { ClientPacketEncoding } from "./flash/api/Packet";
import type { flashRuntime } from "./flash";

type GameRuntime = Pick<typeof flashRuntime, "runPromise">;

interface QueueState {
  readonly delayMs: number;
  readonly packets: readonly string[];
  readonly target: PacketSendTarget;
  index: number;
  stopped: boolean;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

export interface PacketsBridgeController {
  readonly dispose: () => void;
  readonly startCapture: () => Promise<void>;
  readonly startQueue: (payload: PacketQueuePayload) => void;
  readonly stopActive: (stoppedReason?: string) => void;
  readonly stopCapture: () => void;
  readonly stopQueue: () => void;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message !== ""
    ? cause.message
    : "The packet request failed.";

const sendPacketEffect = Effect.fn("packetsBridge.sendPacket")(function* (
  payload: PacketSendPayload,
) {
  const api = yield* Api;
  let sent: boolean;

  if (payload.target === "server-string") {
    sent = yield* api.packet.sendToServer(payload.packet, "string");
  } else if (payload.target === "server-json") {
    sent = yield* api.packet.sendToServer(payload.packet, "json");
  } else {
    const encoding: ClientPacketEncoding =
      payload.target === "client-json"
        ? "json"
        : payload.target === "client-xml"
          ? "xml"
          : "string";
    sent = yield* api.packet.sendToClient(payload.packet, encoding);
  }

  if (!sent) {
    return yield* new PacketsError({
      detail: "The game rejected the packet send request.",
    });
  }
});

export const installPacketsBridge = (
  runtime: GameRuntime,
  packetsBridge: DesktopGamePacketsBridge,
): PacketsBridgeController => {
  let captureDispose: (() => void) | undefined;
  let captureGeneration = 0;
  let connectionDispose: (() => void) | undefined;
  let disposed = false;
  let queueState: QueueState | undefined;

  const publishStatus = (stoppedReason?: string): void => {
    void packetsBridge
      .publishStatus({
        captureRunning: captureDispose !== undefined,
        queueRunning: queueState !== undefined && !queueState.stopped,
        ...(stoppedReason === undefined ? {} : { stoppedReason }),
      })
      .catch((cause: unknown) => {
        console.error("[game:packets] failed to publish status", cause);
      });
  };

  const stopCapture = (publish = true): void => {
    const wasRunning = captureDispose !== undefined;
    captureGeneration += 1;
    captureDispose?.();
    captureDispose = undefined;
    if (publish && wasRunning) {
      publishStatus();
    }
  };

  const startCapture = async (): Promise<void> => {
    stopCapture(false);
    const generation = captureGeneration + 1;
    captureGeneration = generation;
    const dispose = await runtime.runPromise(
      Effect.gen(function* () {
        const api = yield* Api;
        return yield* api.packet.onRaw((packet) =>
          Effect.promise(() =>
            packetsBridge
              .publishCaptured({
                capturedAt: Date.now(),
                packet: packet.raw,
                type: packet.direction,
              })
              .catch((cause: unknown) => {
                console.error(
                  "[game:packets] failed to publish captured packet",
                  cause,
                );
              }),
          ),
        );
      }),
    );

    if (disposed || generation !== captureGeneration) {
      dispose();
      throw new Error("Packet capture start was interrupted.");
    }
    captureDispose = dispose;
    publishStatus();
  };

  const sendPacket = (payload: PacketSendPayload): Promise<void> =>
    runtime.runPromise(sendPacketEffect(payload));

  const clearQueueTimer = (): void => {
    if (queueState?.timeout !== undefined) {
      clearTimeout(queueState.timeout);
      queueState.timeout = undefined;
    }
  };

  const stopQueue = (publish = true): void => {
    const wasRunning = queueState !== undefined && !queueState.stopped;
    if (queueState !== undefined) {
      queueState.stopped = true;
    }
    clearQueueTimer();
    queueState = undefined;
    if (publish && wasRunning) {
      publishStatus();
    }
  };

  const scheduleQueue = (state: QueueState): void => {
    if (queueState !== state || state.stopped) {
      return;
    }
    state.timeout = setTimeout(() => {
      void runQueueOnce();
    }, state.delayMs);
  };

  const runQueueOnce = async (): Promise<void> => {
    const state = queueState;
    if (state === undefined || state.stopped || state.packets.length === 0) {
      stopQueue();
      return;
    }

    const packet = state.packets[state.index];
    state.index = (state.index + 1) % state.packets.length;
    try {
      await sendPacket({ packet: packet ?? "", target: state.target });
    } catch (cause) {
      console.error("[game:packets] queue send failed", cause);
      stopQueue(false);
      publishStatus("Queue stopped after a send failure");
      return;
    }
    scheduleQueue(state);
  };

  const startQueue = (payload: PacketQueuePayload): void => {
    stopQueue(false);
    queueState = {
      delayMs: payload.delayMs,
      index: 0,
      packets: payload.packets,
      stopped: false,
      target: payload.target,
      timeout: undefined,
    };
    void runQueueOnce();
    publishStatus();
  };

  const stopActive = (stoppedReason?: string): void => {
    const wasRunning =
      captureDispose !== undefined ||
      (queueState !== undefined && !queueState.stopped);
    stopCapture(false);
    stopQueue(false);
    if (wasRunning && stoppedReason !== undefined) {
      publishStatus(stoppedReason);
    }
  };

  void runtime
    .runPromise(
      Effect.gen(function* () {
        const api = yield* Api;
        return yield* api.events.on({ type: "connection" }, (event) =>
          Effect.sync(() => {
            if (
              event.status === "OnConnectionLost" ||
              event.status === "OnConnectionFailed"
            ) {
              stopActive(
                "Packet activity stopped because the game disconnected",
              );
            }
          }),
        );
      }),
    )
    .then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        connectionDispose = dispose;
      }
    })
    .catch((cause: unknown) => {
      console.error("[game:packets] connection subscription failed", cause);
    });

  return {
    dispose: () => {
      disposed = true;
      connectionDispose?.();
      connectionDispose = undefined;
      stopActive();
    },
    startCapture,
    startQueue,
    stopActive,
    stopCapture,
    stopQueue,
  };
};

export const makePacketsRpcHandlers = (packets: PacketsBridgeController) =>
  PacketsRpcs.toLayer(
    Effect.gen(function* () {
      const requests = yield* Semaphore.make(1);
      const toPacketsError = (cause: unknown) =>
        new PacketsError({ detail: errorMessage(cause) });
      const run = (operation: () => void) =>
        requests.withPermit(
          Effect.try({ try: operation, catch: toPacketsError }),
        );
      return PacketsRpcs.of({
        PacketsSend: (payload) =>
          requests.withPermit(sendPacketEffect(payload)),
        PacketsStartCapture: () =>
          requests.withPermit(
            Effect.tryPromise({
              try: packets.startCapture,
              catch: toPacketsError,
            }),
          ),
        PacketsStartQueue: (payload) => run(() => packets.startQueue(payload)),
        PacketsStopCapture: () => run(() => packets.stopCapture()),
        PacketsStopQueue: () => run(() => packets.stopQueue()),
      });
    }),
  );

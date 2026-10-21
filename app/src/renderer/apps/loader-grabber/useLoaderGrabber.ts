import { useCallback, useRef, useState } from "react";

import type { DesktopLoaderGrabberWindowBridge } from "../../../shared/desktopBridge";
import type { LoaderGrabberLoadRequest } from "../../../shared/loader-grabber";
import {
  buildSnapshot,
  describeOpenRequest,
  openTargetInfo,
  type Snapshot,
  type Source,
} from "./model";

export type SourceState =
  | { readonly status: "idle" }
  | { readonly status: "reading"; readonly last: Snapshot | null }
  | { readonly status: "ready"; readonly snapshot: Snapshot }
  | { readonly status: "missing" }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly last: Snapshot | null;
    };

export type ReadOutcome =
  | { readonly status: "ready"; readonly snapshot: Snapshot }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly message: string };

export type OpenOutcome =
  | {
      readonly status: "opened";
      readonly source: Source | null;
      readonly focus: string | null;
    }
  | { readonly status: "failed"; readonly message: string };

export interface LoaderGrabber {
  readonly states: Readonly<Record<Source, SourceState>>;
  readonly opening: LoaderGrabberLoadRequest | null;
  readonly grab: (source: Source) => Promise<ReadOutcome>;
  readonly open: (request: LoaderGrabberLoadRequest) => Promise<OpenOutcome>;
}

export const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

export const lastSnapshot = (state: SourceState): Snapshot | null => {
  switch (state.status) {
    case "ready":
      return state.snapshot;
    case "reading":
    case "failed":
      return state.last;
    case "idle":
    case "missing":
      return null;
  }
};

const IDLE: Readonly<Record<Source, SourceState>> = {
  bank: { status: "idle" },
  "cell-monsters": { status: "idle" },
  inventory: { status: "idle" },
  "map-monsters": { status: "idle" },
  quest: { status: "idle" },
  shop: { status: "idle" },
  "temp-inventory": { status: "idle" },
};

export function useLoaderGrabber(
  bridge: DesktopLoaderGrabberWindowBridge,
): LoaderGrabber {
  const [states, setStates] = useState(IDLE);
  const [opening, setOpening] = useState<LoaderGrabberLoadRequest | null>(null);
  const tokens = useRef(new Map<Source, number>());
  const reads = useRef(new Map<Source, Promise<ReadOutcome>>());

  const read = useCallback(
    (source: Source): Promise<ReadOutcome> => {
      const token = (tokens.current.get(source) ?? 0) + 1;
      tokens.current.set(source, token);
      const settle = (next: (current: SourceState) => SourceState): void => {
        if (tokens.current.get(source) === token) {
          setStates((current) => ({
            ...current,
            [source]: next(current[source]),
          }));
        }
      };

      settle((current) => ({ last: lastSnapshot(current), status: "reading" }));
      const pending = (async (): Promise<ReadOutcome> => {
        try {
          const data = await bridge.grab({ type: source });
          const snapshot = buildSnapshot(source, data, Date.now());
          const outcome: ReadOutcome =
            snapshot === null
              ? { status: "missing" }
              : { snapshot, status: "ready" };
          settle(() => outcome);
          return outcome;
        } catch (cause) {
          window.desktop.log.warn(`Failed to read ${source}`, cause);
          const message = errorMessage(cause, "The game didn't give a reason.");
          settle((current) => ({
            last: lastSnapshot(current),
            message,
            status: "failed",
          }));
          return { message, status: "failed" };
        }
      })();
      reads.current.set(source, pending);
      void pending.then(() => {
        if (reads.current.get(source) === pending) {
          reads.current.delete(source);
        }
      });
      return pending;
    },
    [bridge],
  );

  const grab = useCallback(
    (source: Source): Promise<ReadOutcome> =>
      reads.current.get(source) ?? read(source),
    [read],
  );

  const open = useCallback(
    async (request: LoaderGrabberLoadRequest): Promise<OpenOutcome> => {
      setOpening(request);
      try {
        await bridge.load(request);
      } catch (cause) {
        window.desktop.log.warn("Failed to load from loader grabber", cause);
        setOpening(null);
        return {
          message: errorMessage(
            cause,
            `Couldn't open ${describeOpenRequest(request).toLocaleLowerCase()}.`,
          ),
          status: "failed",
        };
      }

      const source = openTargetInfo(request.type).opens;
      const outcome = source === null ? null : await read(source);
      setOpening(null);
      if (outcome?.status === "failed") {
        return {
          message: `${describeOpenRequest(request)} opened in the game, but Lucent couldn't read it. ${outcome.message}`,
          status: "failed",
        };
      }
      const focus =
        request.type === "quest" &&
        outcome?.status === "ready" &&
        outcome.snapshot.entries.some(
          (entry) => entry.key === String(request.id),
        )
          ? String(request.id)
          : null;
      return { focus, source, status: "opened" };
    },
    [bridge, read],
  );

  return { grab, open, opening, states };
}

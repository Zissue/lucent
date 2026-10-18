import { describe, expect, it } from "@effect/vitest";

import { vi } from "vitest";
import type { IpcRendererEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { defineEvent } from "../shared/ipc/core";
import {
  RendererLogIpc,
  type RendererLogRecord,
} from "../shared/ipc/rendererLog";
const electron = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: electron }));

import { CombatProfilesIpc, EnvironmentIpc, UpdatesIpc } from "../shared/ipc";
import { createEmptyEnvironmentState } from "@lucent/core/environment";
import { UpdateReleaseInfo } from "../shared/updates";
import { createDesktopIpcInvokeHandler } from "./ipc/DesktopIpcInvoke";
import {
  createInvoke,
  createSubscribe,
  DesktopBridgeError,
} from "./preloadIpcClient";

describe("preload ipc client", () => {
  it("preserves accepted payloads with extra keys", async () => {
    const handle = createDesktopIpcInvokeHandler(
      EnvironmentIpc.setQuestAutoRegister,
      (options) =>
        Effect.succeed({
          ...createEmptyEnvironmentState(),
          questAutoRegister: options,
        }),
      Effect.runPromise,
    );
    const invoke = createInvoke((_channel, payload) =>
      handle(undefined, payload),
    );
    const payload = { requirements: true, rewards: false, extra: 1 };
    const state = await invoke(EnvironmentIpc.setQuestAutoRegister, payload);
    expect(state.questAutoRegister).toEqual({
      requirements: true,
      rewards: false,
    });
  });

  it("preserves main's profile normalization and strips extra result fields", async () => {
    const handle = createDesktopIpcInvokeHandler(
      CombatProfilesIpc.saveProfile,
      (profile) =>
        Effect.succeed({
          version: 1 as const,
          profiles: [{ ...profile, privateField: "secret" }],
        }),
      Effect.runPromise,
    );
    const invoke = createInvoke((_channel, payload) =>
      handle(undefined, payload),
    );

    await expect(
      invoke(CombatProfilesIpc.saveProfile, {
        id: "  custom  ",
        label: "  Hero  ",
        delayMs: 150,
        cooldownMode: "use-if-ready",
        steps: [
          {
            skill: 1,
            conditions: [
              { type: "target-aura", auraName: "  Burn  ", op: ">=", value: 1 },
            ],
          },
        ],
      }),
    ).resolves.toEqual({
      version: 1,
      profiles: [
        {
          id: "custom",
          label: "Hero",
          delayMs: 150,
          cooldownMode: "use-if-ready",
          steps: [
            {
              skill: 1,
              conditions: [
                { type: "target-aura", auraName: "Burn", op: ">=", value: 1 },
              ],
            },
          ],
        },
      ],
    });
  });

  it("preserves release fields after IPC copies a schema class", async () => {
    const handle = createDesktopIpcInvokeHandler(
      UpdatesIpc.getState,
      () =>
        Effect.succeed({
          status: "available" as const,
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          checkedAt: "2026-10-17T00:00:00Z",
          release: new UpdateReleaseInfo({
            version: "2.0.0",
            tagName: "v2.0.0",
            htmlUrl: "https://example.com/release",
          }),
        }),
      Effect.runPromise,
    );
    const invoke = createInvoke(async (_channel, payload) =>
      structuredClone(await handle(undefined, payload)),
    );

    expect(
      structuredClone(await invoke(UpdatesIpc.getState, undefined)),
    ).toEqual({
      status: "available",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      checkedAt: "2026-10-17T00:00:00Z",
      release: {
        version: "2.0.0",
        tagName: "v2.0.0",
        htmlUrl: "https://example.com/release",
      },
    });
  });

  it("preserves the bridge failure message and error name", async () => {
    const invoke = createInvoke(async () => ({
      ok: false,
      message: "Service unavailable.",
    }));
    const error: unknown = await invoke(
      UpdatesIpc.openReleasePage,
      undefined,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DesktopBridgeError);
    if (!(error instanceof DesktopBridgeError)) throw error;
    expect({
      name: error.name,
      message: error.message,
      text: String(error),
    }).toEqual({
      name: "DesktopBridgeError",
      message: "Service unavailable.",
      text: "DesktopBridgeError: Service unavailable.",
    });
  });

  it("unwraps successful invoke envelopes", async () => {
    const calls: Array<{
      readonly channel: string;
      readonly payload: unknown;
    }> = [];
    const invoke = createInvoke(async (channel, payload) => {
      calls.push({ channel, payload });
      return { ok: true, value: true };
    });

    await expect(invoke(UpdatesIpc.openReleasePage, undefined)).resolves.toBe(
      true,
    );
    expect(calls).toEqual([
      { channel: UpdatesIpc.openReleasePage.channel, payload: undefined },
    ]);
  });
});

const event = {} as IpcRendererEvent;

describe("preload event failure logging", () => {
  it("reports callback failure episodes without payloads and keeps success silent", () => {
    electron.send.mockClear();
    const records: RendererLogRecord[] = [];
    electron.send.mockImplementation(
      (channel: string, record: RendererLogRecord) => {
        expect(channel).toBe(RendererLogIpc.record.channel);
        records.push(RendererLogIpc.record.decodePayload(record));
      },
    );
    const descriptor = defineEvent({
      channel: "desktop:test:changed",
      payload: Schema.Number,
    });
    let subscription: (
      event: IpcRendererEvent,
      payload: unknown,
    ) => void = () => {};
    let removed = false;
    let fail = false;
    const received: number[] = [];
    const unsubscribe = createSubscribe({
      on: (_channel, listener) => {
        subscription = listener;
      },
      removeListener: (_channel, listener) => {
        removed = listener === subscription;
      },
    })(descriptor, (value) => {
      if (fail) throw new Error(`callback rejected private token ${value}`);
      received.push(value);
    });
    subscription(event, 1);
    fail = true;
    subscription(event, 8675309);
    subscription(event, 8675309);
    expect(
      records.map(({ level, message, component, data, repeatKey }) => ({
        level,
        message,
        component,
        data,
        repeatKey,
      })),
    ).toEqual([
      {
        level: "error",
        message: "Renderer event handler failed",
        component: "preload",
        data: {
          channel: "desktop:test:changed",
        },
        repeatKey: "desktop:test:changed",
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("private token");
    expect(JSON.stringify(records)).not.toContain("8675309");
    fail = false;
    subscription(event, 2);
    expect(received).toEqual([1, 2]);
    expect(records).toHaveLength(1);
    fail = true;
    subscription(event, 8675309);
    expect(records.map((record) => record.data)).toEqual([
      { channel: "desktop:test:changed" },
      { channel: "desktop:test:changed" },
    ]);
    unsubscribe();
    expect(removed).toBe(true);
  });

  it("unsubscribes repeated listeners independently", () => {
    const subscriptions = new Set<
      (event: IpcRendererEvent, payload: unknown) => void
    >();
    const subscribe = createSubscribe({
      on: (_channel, listener) => {
        subscriptions.add(listener);
      },
      removeListener: (_channel, listener) => {
        subscriptions.delete(listener);
      },
    });
    const descriptor = defineEvent({
      channel: "desktop:test:number",
      payload: Schema.Number,
    });
    const received: number[] = [];
    const listener = (value: number) => {
      received.push(value);
    };
    const first = subscribe(descriptor, listener);
    const second = subscribe(descriptor, listener);
    for (const subscription of subscriptions) subscription(event, 1);
    first();
    for (const subscription of subscriptions) subscription(event, 2);
    second();
    for (const subscription of subscriptions) subscription(event, 3);
    expect(received).toEqual([1, 1, 2]);
  });

  it("contains renderer log transport failures", () => {
    electron.send.mockImplementation(() => {
      throw new Error("renderer closed");
    });
    let subscription: (
      event: IpcRendererEvent,
      payload: unknown,
    ) => void = () => {};
    const values: number[] = [];
    createSubscribe({
      on: (_channel, listener) => {
        subscription = listener;
      },
      removeListener: () => {},
    })(
      defineEvent({
        channel: "desktop:test:number",
        payload: Schema.Number,
      }),
      (value) => {
        if (value === 1) throw new Error("listener failed");
        values.push(value);
      },
    );
    subscription(event, 1);
    subscription(event, 3);
    expect(values).toEqual([3]);
  });
});

import { describe, expect, it } from "@effect/vitest";

import { vi } from "vitest";
import * as Schema from "effect/Schema";
import { defineEvent } from "../shared/ipc/core";
import {
  RendererLogIpc,
  type RendererLogRecord,
} from "../shared/ipc/rendererLog";
const electron = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: electron }));

import { UpdatesIpc } from "../shared/ipc";
import {
  createInvoke,
  createSubscribe,
  DesktopBridgeError,
} from "./preloadIpcClient";

describe("preload ipc client", () => {
  it.each([{}, { channel: "desktop:test:invoke" }])(
    "preserves bridge failure details for %j",
    async (fields) => {
      const invoke = createInvoke(async () => ({
        ok: false,
        error: {
          ...fields,
          code: "UNAVAILABLE",
          message: "Service unavailable.",
        },
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
        code: error.code,
        channel: error.channel,
        text: String(error),
        ownChannel: Object.hasOwn(error, "channel"),
      }).toEqual({
        name: "DesktopBridgeError",
        message: "Service unavailable.",
        code: "UNAVAILABLE",
        channel: fields.channel,
        text: "DesktopBridgeError: Service unavailable.",
        ownChannel: true,
      });
    },
  );

  it("accepts an explicitly undefined bridge channel", () => {
    const fields = { code: "UNAVAILABLE", message: "Service unavailable." };
    Reflect.set(fields, "channel", undefined);
    const error = new DesktopBridgeError(fields);
    expect({
      channel: error.channel,
      code: error.code,
      message: error.message,
    }).toEqual({
      channel: undefined,
      code: "UNAVAILABLE",
      message: "Service unavailable.",
    });
  });

  it("unwraps successful and failed invoke envelopes", async () => {
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

    const failingInvoke = createInvoke(async () => ({
      ok: false,
      error: {
        channel: UpdatesIpc.openReleasePage.channel,
        code: "NO_RELEASE",
        message: "No release URL is available.",
      },
    }));

    await expect(
      failingInvoke(UpdatesIpc.openReleasePage, undefined),
    ).rejects.toBeInstanceOf(DesktopBridgeError);
    await expect(
      failingInvoke(UpdatesIpc.openReleasePage, undefined),
    ).rejects.toMatchObject({
      code: "NO_RELEASE",
      message: "No release URL is available.",
    });
  });
});

describe("preload event failure logging", () => {
  it("reports decode and callback episodes without payloads and keeps success silent", () => {
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
      name: "test.changed",
      payload: Schema.Number,
    });
    let subscription: (payload: unknown) => void = () => {};
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
    subscription("private-event-token");
    subscription("private-event-token");
    subscription(1);
    fail = true;
    subscription(8675309);
    subscription(8675309);
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
          eventName: "test.changed",
          phase: "decode",
        },
        repeatKey: "desktop:test:changed:test.changed:decode",
      },
      {
        level: "error",
        message: "Renderer event handler failed",
        component: "preload",
        data: {
          channel: "desktop:test:changed",
          eventName: "test.changed",
          phase: "callback",
        },
        repeatKey: "desktop:test:changed:test.changed:callback",
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("private-event-token");
    expect(JSON.stringify(records)).not.toContain("8675309");
    fail = false;
    subscription(2);
    expect(received).toEqual([1, 2]);
    expect(records).toHaveLength(2);
    subscription("private-event-token");
    fail = true;
    subscription(8675309);
    expect(records.map((record) => record.data)).toEqual([
      {
        channel: "desktop:test:changed",
        eventName: "test.changed",
        phase: "decode",
      },
      {
        channel: "desktop:test:changed",
        eventName: "test.changed",
        phase: "callback",
      },
      {
        channel: "desktop:test:changed",
        eventName: "test.changed",
        phase: "decode",
      },
      {
        channel: "desktop:test:changed",
        eventName: "test.changed",
        phase: "callback",
      },
    ]);
    unsubscribe();
    expect(removed).toBe(true);
  });

  it("contains renderer log transport failures", () => {
    electron.send.mockImplementation(() => {
      throw new Error("renderer closed");
    });
    let subscription: (payload: unknown) => void = () => {};
    const values: number[] = [];
    createSubscribe({
      on: (_channel, listener) => {
        subscription = listener;
      },
      removeListener: () => {},
    })(
      defineEvent({
        channel: "desktop:test:number",
        name: "test.number",
        payload: Schema.Number,
      }),
      (value) => values.push(value),
    );
    subscription("invalid");
    subscription(3);
    expect(values).toEqual([3]);
  });
});

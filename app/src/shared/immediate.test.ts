import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMessageChannelImmediate } from "./immediate";

describe("makeMessageChannelImmediate", () => {
  let channel: MessageChannel;

  beforeEach(() => {
    channel = new MessageChannel();
    vi.spyOn(globalThis, "MessageChannel").mockImplementation(function () {
      return channel;
    });
  });

  afterEach(() => {
    channel.port1.close();
    channel.port2.close();
    vi.restoreAllMocks();
  });

  it("runs callbacks asynchronously in scheduling order", async () => {
    const { setImmediate } = makeMessageChannelImmediate();
    const calls: number[] = [];

    const done = new Promise<void>((resolve) => {
      setImmediate(() => calls.push(1));
      setImmediate(() => {
        calls.push(2);
        resolve();
      });
    });
    expect(calls).toEqual([]);

    await done;
    expect(calls).toEqual([1, 2]);
  });

  it("passes extra arguments to the callback", async () => {
    const { setImmediate } = makeMessageChannelImmediate();

    const received = await new Promise<readonly [string, number]>((resolve) => {
      setImmediate(
        (label: string, count: number) => resolve([label, count]),
        "expected",
        2,
      );
    });

    expect(received).toEqual(["expected", 2]);
  });

  it("skips cleared callbacks", async () => {
    const { setImmediate, clearImmediate } = makeMessageChannelImmediate();
    const calls: string[] = [];

    const done = new Promise<void>((resolve) => {
      clearImmediate(setImmediate(() => calls.push("cleared")));
      setImmediate(() => {
        calls.push("kept");
        resolve();
      });
    });

    await done;
    expect(calls).toEqual(["kept"]);
  });
});

type ImmediateCallback = () => void;

export interface Immediate {
  readonly setImmediate: <Args extends readonly unknown[]>(
    callback: (...args: Args) => void,
    ...args: Args
  ) => number;
  readonly clearImmediate: (handle: number) => void;
}

export const makeMessageChannelImmediate = (): Immediate => {
  const channel = new MessageChannel();
  const pending = new Map<number, ImmediateCallback>();
  let nextHandle = 0;

  channel.port1.onmessage = (event: MessageEvent<number>) => {
    const callback = pending.get(event.data);
    if (callback === undefined) {
      return;
    }

    pending.delete(event.data);
    callback();
  };

  return {
    setImmediate: (callback, ...args) => {
      nextHandle += 1;
      pending.set(nextHandle, () => callback(...args));
      channel.port2.postMessage(nextHandle);
      return nextHandle;
    },
    clearImmediate: (handle) => {
      pending.delete(handle);
    },
  };
};

if (!("setImmediate" in globalThis)) {
  const { setImmediate, clearImmediate } = makeMessageChannelImmediate();
  Object.assign(globalThis, { setImmediate, clearImmediate });
}

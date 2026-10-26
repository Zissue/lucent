/** The functions the `js` crate installs as `globalThis.__host`. */
export interface Host {
  /** Milliseconds since the runtime started. */
  now(): number;
  log(level: 0 | 1 | 2 | 3, text: string): void;
  /** Arms or disarms the watchdog that terminates a turn that never yields. */
  watch(armed: boolean): void;
  call(
    op: string,
    ...args: (string | number | boolean | null | undefined)[]
  ): string | number | boolean | undefined;
}

export const host = (): Host => (globalThis as { __host?: Host }).__host!;

export interface Inbound {
  readonly t: string;
}

const handlers = new Map<string, (item: Inbound) => void>();

/** Routes inbound items whose `t` is `type` to `handler`. Rust owns the item shapes. */
export const onInbound = <Item extends object>(
  type: string,
  handler: (item: Item) => void,
): void => {
  handlers.set(type, handler as unknown as (item: Inbound) => void);
};

export const dispatchInbound = (item: Inbound): void => {
  const handler = handlers.get(item.t);
  if (handler === undefined) {
    host().log(2, `No handler for inbound item ${item.t}`);
    return;
  }
  handler(item);
};

import { dispatchInbound, host, type Inbound } from "./host";

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
  readonly repeat?: number;
}

const live = new Map<number, Timer>();
const heap: Timer[] = [];
let immediate: Timer[] = [];
let nextId = 1;

const push = (entry: Timer): void => {
  let index = heap.length;
  heap.push(entry);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent]!.at <= entry.at) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = entry;
};

const pop = (): Timer => {
  const first = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && heap[child + 1]!.at < heap[child]!.at) {
        child++;
      }
      if (last.at <= heap[child]!.at) break;
      heap[index] = heap[child]!;
      index = child;
    }
    heap[index] = last;
  }
  return first;
};

const trim = (): void => {
  while (heap.length > 0 && !live.has(heap[0]!.id)) pop();
};

const report = (what: string, cause: unknown): void => {
  const text =
    cause instanceof Error ? (cause.stack ?? String(cause)) : String(cause);
  host().log(3, `${what}: ${text}`);
};

const fire = (entry: Timer): void => {
  if (live.get(entry.id) !== entry) return;
  if (entry.repeat === undefined) {
    live.delete(entry.id);
  } else {
    const next = { ...entry, at: host().now() + entry.repeat };
    live.set(entry.id, next);
    push(next);
  }
  try {
    entry.fn();
  } catch (cause) {
    report("Uncaught error in a timer", cause);
  }
};

const schedule = (fn: () => void, delay: unknown, repeat: boolean): number => {
  const ms = Math.max(0, Number(delay) || 0);
  const entry: Timer = {
    id: nextId++,
    at: host().now() + ms,
    fn,
    ...(repeat ? { repeat: Math.max(1, ms) } : {}),
  };
  live.set(entry.id, entry);
  push(entry);
  return entry.id;
};

const turn = (text: string): void => {
  for (const item of JSON.parse(text) as Inbound[]) {
    try {
      dispatchInbound(item);
    } catch (cause) {
      report(`Uncaught error handling ${item.t}`, cause);
    }
  }
  const round = immediate;
  immediate = [];
  for (const entry of round) fire(entry);
  trim();
  while (heap.length > 0 && heap[0]!.at <= host().now()) {
    fire(pop());
    trim();
  }
};

const wake = (): number => {
  trim();
  if (immediate.some((entry) => live.get(entry.id) === entry)) return 0;
  return heap[0]?.at ?? Infinity;
};

Object.assign(globalThis, {
  setTimeout: (
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => schedule(() => fn(...args), delay, false),
  setInterval: (
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => schedule(() => fn(...args), delay, true),
  clearTimeout: (id: unknown) => {
    live.delete(Number(id));
  },
  clearInterval: (id: unknown) => {
    live.delete(Number(id));
  },
  setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    const entry: Timer = { id: nextId++, at: 0, fn: () => fn(...args) };
    live.set(entry.id, entry);
    immediate.push(entry);
    return entry.id;
  },
  clearImmediate: (id: unknown) => {
    live.delete(Number(id));
  },
});

if (typeof globalThis.queueMicrotask !== "function") {
  globalThis.queueMicrotask = (fn: () => void) => {
    void Promise.resolve().then(fn);
  };
}

const format = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const consoleAt =
  (level: 0 | 1 | 2 | 3) =>
  (...args: unknown[]): void =>
    host().log(level, args.map(format).join(" "));

Object.assign(globalThis, {
  console: {
    debug: consoleAt(0),
    trace: consoleAt(0),
    log: consoleAt(1),
    info: consoleAt(1),
    warn: consoleAt(2),
    error: consoleAt(3),
  },
  performance: {
    now: () => host().now(),
    timeOrigin: Date.now(),
    mark: () => undefined,
    measure: () => undefined,
  },
  __lucent: Object.freeze({ turn, wake }),
});

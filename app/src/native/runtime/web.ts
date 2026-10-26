import { host } from "./host";

const provide = (name: string, value: unknown): void => {
  if (Reflect.get(globalThis, name) === undefined)
    Reflect.set(globalThis, name, value);
};

Reflect.set(globalThis, "window", globalThis);
Reflect.set(globalThis, "self", globalThis);

class LucentEvent {
  readonly type: string;
  defaultPrevented = false;
  constructor(type: string) {
    this.type = type;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type Listener =
  | ((event: LucentEvent) => void)
  | { handleEvent(event: LucentEvent): void };

class LucentEventTarget {
  readonly #listeners = new Map<
    string,
    { listener: Listener; once: boolean }[]
  >();

  addEventListener(
    type: string,
    listener: Listener | null,
    options?: boolean | { once?: boolean },
  ): void {
    if (listener === null) return;
    const entries = this.#listeners.get(type) ?? [];
    if (entries.some((entry) => entry.listener === listener)) return;
    entries.push({
      listener,
      once: typeof options === "object" && options.once === true,
    });
    this.#listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: Listener | null): void {
    const entries = this.#listeners.get(type);
    if (entries === undefined) return;
    this.#listeners.set(
      type,
      entries.filter((entry) => entry.listener !== listener),
    );
  }

  dispatchEvent(event: LucentEvent): boolean {
    for (const entry of [...(this.#listeners.get(event.type) ?? [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.listener);
      try {
        if (typeof entry.listener === "function")
          entry.listener.call(this, event);
        else entry.listener.handleEvent(event);
      } catch (cause) {
        queueMicrotask(() => {
          throw cause;
        });
      }
    }
    return !event.defaultPrevented;
  }
}

const abortError = (): Error => {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
};

class LucentAbortSignal extends LucentEventTarget {
  aborted = false;
  reason: unknown = undefined;
  onabort: ((event: LucentEvent) => void) | null = null;

  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }

  static abort(reason?: unknown): LucentAbortSignal {
    const controller = new LucentAbortController();
    controller.abort(reason);
    return controller.signal;
  }

  static timeout(ms: number): LucentAbortSignal {
    const controller = new LucentAbortController();
    setTimeout(() => {
      const error = new Error("The operation timed out.");
      error.name = "TimeoutError";
      controller.abort(error);
    }, ms);
    return controller.signal;
  }

  static any(signals: readonly LucentAbortSignal[]): LucentAbortSignal {
    const controller = new LucentAbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        return controller.signal;
      }
    }
    for (const signal of signals) {
      signal.addEventListener("abort", () => controller.abort(signal.reason), {
        once: true,
      });
    }
    return controller.signal;
  }
}

class LucentAbortController {
  readonly signal = new LucentAbortSignal();

  abort(reason?: unknown): void {
    const signal = this.signal;
    if (signal.aborted) return;
    signal.aborted = true;
    signal.reason = reason === undefined ? abortError() : reason;
    const event = new LucentEvent("abort");
    signal.onabort?.(event);
    signal.dispatchEvent(event);
  }
}

provide("Event", LucentEvent);
provide("EventTarget", LucentEventTarget);
provide("AbortSignal", LucentAbortSignal);
provide("AbortController", LucentAbortController);

if (Reflect.get(globalThis, "addEventListener") === undefined) {
  const target = new LucentEventTarget();
  Object.assign(globalThis, {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
}

provide(
  "TextEncoder",
  class TextEncoder {
    get encoding(): string {
      return "utf-8";
    }
    encode(text = ""): Uint8Array {
      const out: number[] = [];
      for (const ch of text) {
        const c = ch.codePointAt(0)!;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000)
          out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else
          out.push(
            0xf0 | (c >> 18),
            0x80 | ((c >> 12) & 63),
            0x80 | ((c >> 6) & 63),
            0x80 | (c & 63),
          );
      }
      return new Uint8Array(out);
    }
  },
);

provide(
  "TextDecoder",
  class TextDecoder {
    get encoding(): string {
      return "utf-8";
    }
    decode(input?: ArrayBufferView | ArrayBuffer): string {
      if (input === undefined) return "";
      const bytes =
        input instanceof Uint8Array
          ? input
          : ArrayBuffer.isView(input)
            ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
            : new Uint8Array(input);
      let text = "";
      let index = 0;
      while (index < bytes.length) {
        const x = bytes[index++]!;
        let c: number;
        if (x < 0x80) c = x;
        else if (x < 0xe0) c = ((x & 31) << 6) | (bytes[index++]! & 63);
        else if (x < 0xf0)
          c =
            ((x & 15) << 12) |
            ((bytes[index++]! & 63) << 6) |
            (bytes[index++]! & 63);
        else
          c =
            ((x & 7) << 18) |
            ((bytes[index++]! & 63) << 12) |
            ((bytes[index++]! & 63) << 6) |
            (bytes[index++]! & 63);
        text += String.fromCodePoint(c);
      }
      return text;
    }
  },
);

const base64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

provide("btoa", (input: string): string => {
  let out = "";
  for (let index = 0; index < input.length; index += 3) {
    const a = input.charCodeAt(index);
    const b = input.charCodeAt(index + 1);
    const c = input.charCodeAt(index + 2);
    if (a > 255 || b > 255 || c > 255) throw new Error("Invalid character");
    const triple = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += base64[(triple >> 18) & 63]! + base64[(triple >> 12) & 63]!;
    out += Number.isNaN(b) ? "=" : base64[(triple >> 6) & 63]!;
    out += Number.isNaN(c) ? "=" : base64[triple & 63]!;
  }
  return out;
});

provide("atob", (input: string): string => {
  const clean = input.replace(/[\s=]/g, "");
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = base64.indexOf(ch);
    if (value < 0) throw new Error("Invalid character");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 255);
    }
  }
  return out;
});

const fillRandom = <T extends ArrayBufferView | null>(view: T): T => {
  if (view === null) return view;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const hex = String(host().call("random", bytes.length));
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return view;
};

provide("crypto", {
  getRandomValues: fillRandom,
  randomUUID: (): string => {
    const bytes = fillRandom(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
});

const cloneValue = (value: unknown, seen: Map<unknown, unknown>): unknown => {
  if (typeof value === "function" || typeof value === "symbol") {
    const error = new Error(`${String(value)} could not be cloned.`);
    error.name = "DataCloneError";
    throw error;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [key, entry] of value)
      out.set(cloneValue(key, seen), cloneValue(entry, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const entry of value) out.add(cloneValue(entry, seen));
    return out;
  }
  if (ArrayBuffer.isView(value))
    return (value as unknown as { slice(): unknown }).slice();
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const entry of value) out.push(cloneValue(entry, seen));
    return out;
  }
  if (value instanceof Error) {
    const out = new Error(value.message);
    out.name = value.name;
    if (value.stack !== undefined) out.stack = value.stack;
    return out;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, entry] of Object.entries(value))
    out[key] = cloneValue(entry, seen);
  return out;
};

provide("structuredClone", (value: unknown) => cloneValue(value, new Map()));

provide("navigator", {
  userAgent: "Lucent",
  language: "en-US",
  languages: ["en-US"],
});

class LucentURLSearchParams {
  readonly #entries: [string, string][] = [];
  #onChange: (() => void) | undefined;

  constructor(
    init?:
      | string
      | Record<string, string>
      | Iterable<[string, string]>
      | LucentURLSearchParams,
  ) {
    if (typeof init === "string") {
      this.#parse(init);
    } else if (init instanceof LucentURLSearchParams) {
      this.#entries.push(
        ...init.#entries.map(([k, v]): [string, string] => [k, v]),
      );
    } else if (init !== undefined && init !== null) {
      const pairs =
        Symbol.iterator in Object(init)
          ? (init as Iterable<[string, string]>)
          : Object.entries(init as Record<string, string>);
      for (const [key, value] of pairs)
        this.#entries.push([String(key), String(value)]);
    }
  }

  static bind(params: LucentURLSearchParams, onChange: () => void): void {
    params.#onChange = onChange;
  }

  #parse(text: string): void {
    this.#entries.length = 0;
    const query = text.startsWith("?") ? text.slice(1) : text;
    for (const part of query.split("&")) {
      if (part === "") continue;
      const at = part.indexOf("=");
      const key = at < 0 ? part : part.slice(0, at);
      const value = at < 0 ? "" : part.slice(at + 1);
      this.#entries.push([decode(key), decode(value)]);
    }
  }

  replace(text: string): void {
    this.#parse(text);
  }

  get size(): number {
    return this.#entries.length;
  }
  append(key: string, value: string): void {
    this.#entries.push([String(key), String(value)]);
    this.#onChange?.();
  }
  delete(key: string): void {
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      if (this.#entries[index]![0] === key) this.#entries.splice(index, 1);
    }
    this.#onChange?.();
  }
  get(key: string): string | null {
    return this.#entries.find(([k]) => k === key)?.[1] ?? null;
  }
  getAll(key: string): string[] {
    return this.#entries.filter(([k]) => k === key).map(([, v]) => v);
  }
  has(key: string): boolean {
    return this.#entries.some(([k]) => k === key);
  }
  set(key: string, value: string): void {
    const index = this.#entries.findIndex(([k]) => k === key);
    if (index < 0) {
      this.#entries.push([String(key), String(value)]);
    } else {
      this.#entries[index] = [String(key), String(value)];
      for (let next = this.#entries.length - 1; next > index; next--) {
        if (this.#entries[next]![0] === key) this.#entries.splice(next, 1);
      }
    }
    this.#onChange?.();
  }
  sort(): void {
    this.#entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    this.#onChange?.();
  }
  forEach(callback: (value: string, key: string, params: this) => void): void {
    for (const [key, value] of this.#entries) callback(value, key, this);
  }
  keys(): IterableIterator<string> {
    return this.#entries.map(([key]) => key)[Symbol.iterator]();
  }
  values(): IterableIterator<string> {
    return this.#entries.map(([, value]) => value)[Symbol.iterator]();
  }
  entries(): IterableIterator<[string, string]> {
    return this.#entries
      .map(([k, v]): [string, string] => [k, v])
      [Symbol.iterator]();
  }
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }
  toString(): string {
    return this.#entries
      .map(([key, value]) => `${encode(key)}=${encode(value)}`)
      .join("&");
  }
}

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
};

const encode = (text: string): string =>
  encodeURIComponent(text)
    .replace(/%20/g, "+")
    .replace(
      /[!'()~]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );

const defaultPorts: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
  "ftp:": "21",
};

const urlPattern =
  /^([a-zA-Z][a-zA-Z0-9+.-]*:)(?:\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?)?([^?#]*)(\?[^#]*)?(#.*)?$/;

const normalizePath = (path: string): string => {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") {
      if (out.length > 1) out.pop();
    } else if (segment !== ".") {
      out.push(segment);
    }
  }
  const joined = out.join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
};

class LucentURL {
  protocol = "";
  username = "";
  password = "";
  hostname = "";
  #port = "";
  pathname = "";
  #search = "";
  hash = "";
  readonly searchParams: LucentURLSearchParams;

  constructor(input: string | LucentURL, base?: string | LucentURL) {
    const text = String(input).trim();
    const match = urlPattern.exec(text);
    if (match === null) {
      if (base === undefined) throw new TypeError(`Invalid URL: ${text}`);
      const parent = new LucentURL(base);
      this.protocol = parent.protocol;
      this.username = parent.username;
      this.password = parent.password;
      this.hostname = parent.hostname;
      this.#port = parent.port;
      const hashAt = text.indexOf("#");
      const withoutHash = hashAt < 0 ? text : text.slice(0, hashAt);
      this.hash = hashAt < 0 ? "" : text.slice(hashAt);
      const queryAt = withoutHash.indexOf("?");
      const path = queryAt < 0 ? withoutHash : withoutHash.slice(0, queryAt);
      this.#search =
        queryAt < 0
          ? path === ""
            ? parent.search
            : ""
          : withoutHash.slice(queryAt);
      if (path.startsWith("//")) {
        const rebuilt = new LucentURL(`${parent.protocol}${text}`);
        Object.assign(this, rebuilt);
        this.#port = rebuilt.port;
        this.#search = rebuilt.search;
      } else if (path.startsWith("/")) {
        this.pathname = normalizePath(path);
      } else if (path === "") {
        this.pathname = parent.pathname;
      } else {
        const dir = parent.pathname.slice(
          0,
          parent.pathname.lastIndexOf("/") + 1,
        );
        this.pathname = normalizePath(dir + path);
      }
    } else {
      const [
        ,
        protocol,
        username,
        password,
        hostname,
        port,
        path,
        search,
        hash,
      ] = match;
      this.protocol = protocol!.toLowerCase();
      this.username = username ?? "";
      this.password = password ?? "";
      this.hostname = (hostname ?? "").toLowerCase();
      this.#port =
        port === undefined || port === defaultPorts[this.protocol] ? "" : port;
      const special = this.protocol in defaultPorts;
      this.pathname = special ? normalizePath(path || "/") : (path ?? "");
      this.#search = search === "?" ? "" : (search ?? "");
      this.hash = hash === "#" ? "" : (hash ?? "");
      if (special && this.hostname === "")
        throw new TypeError(`Invalid URL: ${text}`);
    }
    this.searchParams = new LucentURLSearchParams(this.#search);
    LucentURLSearchParams.bind(this.searchParams, () => {
      const query = this.searchParams.toString();
      this.#search = query === "" ? "" : `?${query}`;
    });
  }

  get port(): string {
    return this.#port;
  }
  set port(value: string) {
    this.#port =
      String(value) === defaultPorts[this.protocol] ? "" : String(value);
  }
  get host(): string {
    return this.#port === "" ? this.hostname : `${this.hostname}:${this.#port}`;
  }
  get origin(): string {
    return this.protocol in defaultPorts
      ? `${this.protocol}//${this.host}`
      : "null";
  }
  get search(): string {
    return this.#search;
  }
  set search(value: string) {
    const text = String(value);
    this.#search =
      text === "" || text === "?"
        ? ""
        : text.startsWith("?")
          ? text
          : `?${text}`;
    this.searchParams.replace(this.#search);
  }
  get href(): string {
    const auth =
      this.username === "" && this.password === ""
        ? ""
        : `${this.username}${this.password === "" ? "" : `:${this.password}`}@`;
    const authority =
      this.hostname === "" && !(this.protocol in defaultPorts)
        ? ""
        : `//${auth}${this.host}`;
    return `${this.protocol}${authority}${this.pathname}${this.#search}${this.hash}`;
  }
  toString(): string {
    return this.href;
  }
  toJSON(): string {
    return this.href;
  }
  static canParse(input: string, base?: string): boolean {
    try {
      new LucentURL(input, base);
      return true;
    } catch {
      return false;
    }
  }
}

provide("URL", LucentURL);
provide("URLSearchParams", LucentURLSearchParams);

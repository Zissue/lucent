import { host, onInbound } from "../../runtime/host";

type Listener = (cause?: unknown) => void;

const sockets = new Map<number, Socket>();

onInbound<{
  readonly id: number;
  readonly ok: boolean;
  readonly message?: string;
}>("tcp", ({ id, ok, message }) => {
  const socket = sockets.get(id);
  if (socket === undefined) return;
  sockets.delete(id);
  socket.settle(ok ? undefined : new Error(message ?? "connect failed"));
});

/** Connect-only TCP socket, enough for `AccountServerPing`'s latency probe. */
export class Socket {
  readonly #listeners = new Map<string, Listener[]>();
  #id: number | undefined;

  once(event: "connect" | "error", listener: Listener): this {
    this.#listeners.set(event, [
      ...(this.#listeners.get(event) ?? []),
      listener,
    ]);
    return this;
  }

  connect(options: { readonly host: string; readonly port: number }): this {
    const id = Number(host().call("tcpConnect", options.host, options.port));
    this.#id = id;
    sockets.set(id, this);
    return this;
  }

  settle(cause: unknown): void {
    const listeners =
      this.#listeners.get(cause === undefined ? "connect" : "error") ?? [];
    this.#listeners.clear();
    for (const listener of listeners) listener(cause);
  }

  unref(): this {
    return this;
  }

  destroy(): void {
    if (this.#id !== undefined && sockets.delete(this.#id)) {
      host().call("tcpCancel", this.#id);
    }
  }

  removeAllListeners(): this {
    this.#listeners.clear();
    return this;
  }
}

export const createConnection = (): never => {
  throw new Error(
    "node:net createConnection is not available in the native app",
  );
};

export default { Socket, createConnection };

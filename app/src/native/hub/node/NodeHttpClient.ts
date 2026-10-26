import * as Effect from "effect/Effect";
import * as Inspectable from "effect/Inspectable";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { pipeArguments } from "effect/Pipeable";
import * as Stream from "effect/Stream";
import {
  Cookies,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpIncomingMessage,
  UrlParams,
} from "effect/http";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { host, onInbound } from "../../runtime/host";
import { fromBase64, toBase64 } from "./buffer";

interface NativeResponse {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: Record<string, string | string[]>;
  readonly body: string;
}

type Completion =
  | { readonly ok: true; readonly response: NativeResponse }
  | { readonly ok: false; readonly message: string };

const pending = new Map<number, (completion: Completion) => void>();

onInbound<Completion & { readonly id: number }>("http", (completion) => {
  const resolve = pending.get(completion.id);
  if (resolve === undefined) return;
  pending.delete(completion.id);
  resolve(completion);
});

const requestBody = (
  request: HttpClientRequest.HttpClientRequest,
): Uint8Array | undefined => {
  const body = request.body;
  switch (body._tag) {
    case "Uint8Array":
      return body.body;
    case "Raw":
      return body.body instanceof Uint8Array
        ? body.body
        : typeof body.body === "string"
          ? new TextEncoder().encode(body.body)
          : undefined;
    default:
      return undefined;
  }
};

class NativeHttpClientResponse
  extends Inspectable.Class
  implements HttpClientResponse.HttpClientResponse
{
  readonly [HttpIncomingMessage.TypeId] = HttpIncomingMessage.TypeId;
  readonly [HttpClientResponse.TypeId] = HttpClientResponse.TypeId;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: Headers.Headers;
  readonly cookies: Cookies.Cookies;
  readonly remoteAddress = Option.none<string>();
  readonly #body: Uint8Array;

  constructor(
    request: HttpClientRequest.HttpClientRequest,
    response: NativeResponse,
  ) {
    super();
    this.request = request;
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = response.url;
    this.headers = Headers.fromInput(
      Object.fromEntries(
        Object.entries(response.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(", ") : value,
        ]),
      ),
    );
    const setCookie = response.headers["set-cookie"];
    this.cookies = Cookies.fromSetCookie(
      setCookie === undefined
        ? []
        : Array.isArray(setCookie)
          ? setCookie
          : [setCookie],
    );
    this.#body = fromBase64(response.body);
  }

  /** Node's `IncomingHttpHeaders` shape, which `DesktopHttpClient` returns to callers. */
  get rawHeaders(): Record<string, string | string[]> {
    return Object.fromEntries(Object.entries(this.headers));
  }

  override toJSON(): unknown {
    return { _id: "HttpClientResponse", status: this.status, url: this.url };
  }

  pipe() {
    return pipeArguments(this, arguments);
  }

  get stream(): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> {
    return this.#body.byteLength === 0 ? Stream.empty : Stream.make(this.#body);
  }

  get arrayBuffer(): Effect.Effect<
    ArrayBuffer,
    HttpClientError.HttpClientError
  > {
    return Effect.succeed(
      this.#body.buffer.slice(
        this.#body.byteOffset,
        this.#body.byteOffset + this.#body.byteLength,
      ) as ArrayBuffer,
    );
  }

  get text(): Effect.Effect<string, HttpClientError.HttpClientError> {
    return Effect.succeed(new TextDecoder().decode(this.#body));
  }

  get json(): Effect.Effect<never, HttpClientError.HttpClientError> {
    return Effect.flatMap(this.text, (text) =>
      Effect.try({
        try: () => (text === "" ? null : JSON.parse(text)) as never,
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({
              request: this.request,
              response: this,
              cause,
            }),
          }),
      }),
    );
  }

  get urlParamsBody(): Effect.Effect<
    UrlParams.UrlParams,
    HttpClientError.HttpClientError
  > {
    return Effect.map(this.text, (text) =>
      UrlParams.fromInput(new URLSearchParams(text)),
    );
  }

  get formData(): Effect.Effect<never, HttpClientError.HttpClientError> {
    return Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.DecodeError({
          request: this.request,
          response: this,
          description: "form data is not available in the native app",
        }),
      }),
    );
  }
}

const client = HttpClient.make((request, url, signal) =>
  Effect.callback<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  >((resume) => {
    const body = requestBody(request);
    const id = host().call(
      "http",
      JSON.stringify({
        url: url.href,
        method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers)),
        ...(body === undefined ? {} : { body: toBase64(body) }),
      }),
    ) as number;
    const abort = () => {
      pending.delete(id);
      host().call("httpCancel", id);
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.set(id, (completion) => {
      signal.removeEventListener("abort", abort);
      resume(
        completion.ok
          ? Effect.succeed(
              new NativeHttpClientResponse(request, completion.response),
            )
          : Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: completion.message,
                }),
              }),
            ),
      );
    });
    return Effect.sync(abort);
  }),
);

export const layerNodeHttp = Layer.succeed(HttpClient.HttpClient, client);
export const layer = layerNodeHttp;

export { HttpClientRequest };

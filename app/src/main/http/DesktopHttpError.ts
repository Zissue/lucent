import * as Schema from "effect/Schema";

export class DesktopHttpClientError extends Schema.TaggedError<DesktopHttpClientError>()(
  "DesktopHttpClientError",
  {
    kind: Schema.Literals([
      "invalid-url",
      "redirect-failed",
      "request-failed",
      "response-too-large",
      "timeout",
    ]),
    detail: Schema.String,
    url: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
]);

/** Prevents credentials and origin-bound headers from following a redirect. */
export const crossOriginRedirectHeaders = (
  headers: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !CROSS_ORIGIN_SENSITIVE_HEADERS.has(name.toLowerCase()),
    ),
  );

export const clientError = (
  kind: DesktopHttpClientError["kind"],
  detail: string,
  url: URL,
  cause?: unknown,
): DesktopHttpClientError =>
  new DesktopHttpClientError({
    kind,
    detail,
    url: url.href,
    ...(cause === undefined ? {} : { cause }),
  });

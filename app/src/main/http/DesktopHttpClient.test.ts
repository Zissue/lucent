import { afterEach, expect, layer as testLayer } from "@effect/vitest";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  crossOriginRedirectHeaders,
  firstHttpHeader,
  makeDesktopHttpClient,
} from "./DesktopHttpClient";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const responseClient = (body: string) =>
  makeDesktopHttpClient.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              headers: { "content-length": String(body.length) },
            }),
          ),
        ),
      ),
    ),
  );
const fixture = () =>
  Effect.promise(async () => {
    const path = await mkdtemp(join(tmpdir(), "lucent-http-"));
    directories.push(path);
    return path;
  });

testLayer(NodeFileSystem.layer)("desktop HTTP policy", (it) => {
  it.effect(
    "normalizes response headers and strips cross-origin credentials",
    () =>
      Effect.sync(() => {
        expect(
          firstHttpHeader({ "set-cookie": ["", "value"] }, "Set-Cookie"),
        ).toBe("value");
        expect(
          crossOriginRedirectHeaders({
            Accept: "application/json",
            Authorization: "secret",
            Cookie: "secret",
            Host: "example.com",
            "Proxy-Authorization": "secret",
            "User-Agent": "Lucent/test",
          }),
        ).toEqual({ Accept: "application/json", "User-Agent": "Lucent/test" });
      }),
  );
  it.effect.each([undefined, 9, 8])(
    "enforces a buffered response limit of %s bytes",
    (maxBytes) =>
      Effect.gen(function* () {
        const http = yield* responseClient("123456789");
        const result = http.get({
          url: new URL("https://example.com/"),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        });
        if (maxBytes === 8)
          expect((yield* Effect.flip(result)).kind).toBe("response-too-large");
        else expect((yield* result).body.toString()).toBe("123456789");
      }),
  );
  it.effect("does not delete a pre-existing download target", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const targetPath = join(root, "archive");
      yield* Effect.promise(() => writeFile(targetPath, "keep"));
      const http = yield* responseClient("replacement");
      yield* http
        .download({
          url: new URL("https://example.com/"),
          targetPath,
          maxBytes: 1024,
        })
        .pipe(Effect.flip);
      expect(yield* Effect.promise(() => readFile(targetPath, "utf8"))).toBe(
        "keep",
      );
    }),
  );
  it.effect("removes its partial download on a body limit failure", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const http = yield* responseClient("too large");
      const error = yield* http
        .download({
          url: new URL("https://example.com/"),
          targetPath: join(root, "archive"),
          maxBytes: 2,
        })
        .pipe(Effect.flip);
      expect(error.kind).toBe("response-too-large");
      expect(yield* Effect.promise(() => readdir(root))).toEqual([]);
    }),
  );
});

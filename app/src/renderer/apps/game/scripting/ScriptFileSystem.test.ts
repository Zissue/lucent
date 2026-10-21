import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";

import type { DesktopFileSystemBridge } from "../../../../shared/desktopBridge";
import type { FileSystemError } from "./ScriptApi";
import { makeScriptFileSystemApi } from "./ScriptFileSystem";
import { makeScriptAsyncScope } from "./scriptAsyncScope";

const makeBridge = () => ({
  exists: vi.fn<DesktopFileSystemBridge["exists"]>(),
  list: vi.fn<DesktopFileSystemBridge["list"]>(),
  readJson: vi.fn<DesktopFileSystemBridge["readJson"]>(),
  readText: vi.fn<DesktopFileSystemBridge["readText"]>(),
  remove: vi.fn<DesktopFileSystemBridge["remove"]>(),
  writeJson: vi.fn<DesktopFileSystemBridge["writeJson"]>(),
  writeText: vi.fn<DesktopFileSystemBridge["writeText"]>(),
});

describe("script filesystem API", () => {
  for (const stop of ["cancel", "close"] as const) {
    it.effect(`rejects every operation after scope ${stop}`, () =>
      Effect.gen(function* () {
        const bridge = makeBridge();
        bridge.writeText.mockResolvedValue({ ok: true, value: undefined });
        const scope = makeScriptAsyncScope();
        const api = makeScriptFileSystemApi(bridge, scope);
        const write = api.writeText("note.txt", "saved");
        expect(bridge.writeText).not.toHaveBeenCalled();
        yield* write;
        expect(bridge.writeText.mock.calls).toEqual([["note.txt", "saved"]]);
        const pending: Effect.Effect<unknown, FileSystemError>[] = [
          api.exists("note.txt"),
          api.list(),
          api.readJson("state.json"),
          api.readText("note.txt"),
          api.remove("note.txt"),
          api.writeJson("state.json", { count: 3 }),
          write,
        ];

        yield* scope[stop];
        const errors = yield* Effect.forEach(pending, Effect.flip);

        expect(errors.map((error) => error.reason)).toEqual([
          "session-closed",
          "session-closed",
          "session-closed",
          "session-closed",
          "session-closed",
          "session-closed",
          "session-closed",
        ]);
        expect(
          Object.values(bridge).reduce(
            (count, method) => count + method.mock.calls.length,
            0,
          ),
        ).toBe(1);
      }),
    );
  }

  it.effect(
    "returns immutable listings and translates filesystem and transport failures",
    () =>
      Effect.gen(function* () {
        const bridge = makeBridge();
        bridge.list.mockResolvedValue({
          ok: true,
          value: [{ name: "state.json", kind: "file" }],
        });
        bridge.readText.mockResolvedValue({
          ok: false,
          error: { operation: "read-text", path: "nested", reason: "not-file" },
        });
        bridge.exists.mockRejectedValue(new Error("IPC failed"));
        const api = makeScriptFileSystemApi(bridge, makeScriptAsyncScope());

        const entries = yield* api.list();
        expect(entries).toEqual([{ name: "state.json", kind: "file" }]);
        expect(Object.isFrozen(entries)).toBe(true);
        expect(Object.isFrozen(entries[0])).toBe(true);
        expect(yield* api.readText("nested").pipe(Effect.flip)).toMatchObject({
          operation: "read-text",
          path: "nested",
          reason: "not-file",
        });
        expect(yield* api.exists("note.txt").pipe(Effect.flip)).toMatchObject({
          operation: "exists",
          path: "note.txt",
          reason: "unavailable",
        });
      }),
  );

  it.effect("validates JSON and byte limits before invoking the bridge", () =>
    Effect.gen(function* () {
      const bridge = makeBridge();
      bridge.writeJson.mockResolvedValue({ ok: true, value: undefined });
      bridge.writeText.mockResolvedValue({ ok: true, value: undefined });
      const api = makeScriptFileSystemApi(bridge, makeScriptAsyncScope());
      yield* api.writeJson("state.json", { count: 3 });
      yield* api.writeText("note.txt", "saved");

      expect(
        yield* api.writeJson("state.json", undefined).pipe(Effect.flip),
      ).toMatchObject({ reason: "not-json-serializable" });
      expect(
        yield* api
          .writeJson("state.json", "a".repeat(8_388_608))
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "too-large" });
      expect(
        yield* api
          .writeText("note.txt", "é".repeat(4_194_305))
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "too-large" });
      expect(bridge.writeJson.mock.calls).toEqual([
        ["state.json", { count: 3 }],
      ]);
      expect(bridge.writeText.mock.calls).toEqual([["note.txt", "saved"]]);
    }),
  );
});

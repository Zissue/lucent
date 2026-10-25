import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { vi } from "vitest";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../shared/logRecord";

const shell = vi.hoisted(() => ({ openExternal: vi.fn(), openPath: vi.fn() }));
vi.mock("electron", () => ({ shell }));
import { ElectronShell, layer } from "./ElectronShell";

describe("ElectronShell failure logging", () => {
  it.effect(
    "logs external URL rejection with only the host and keeps success silent",
    () => {
      const records: DesktopLogRecord[] = [];
      return Effect.gen(function* () {
        const service = yield* ElectronShell;
        shell.openExternal.mockRejectedValueOnce(
          new Error(
            "OS rejected https://example.com/private?token=secret#account",
          ),
        );
        expect(
          yield* service.openExternal(
            new URL("https://example.com/private?token=secret#account"),
          ),
        ).toBe(false);
        expect(records).toMatchObject([
          {
            level: "warn",
            message: "Failed to open external URL",
            component: "electron-shell",
            data: { host: "example.com" },
            error: [{ message: "OS rejected [target]" }],
          },
        ]);
        expect(records[0]?.data).toEqual({ host: "example.com" });
        expect(JSON.stringify(records)).not.toContain("token=secret");
        shell.openExternal.mockResolvedValueOnce(undefined);
        expect(
          yield* service.openExternal(new URL("https://example.com/")),
        ).toBe(true);
        expect(records).toHaveLength(1);
      }).pipe(
        Effect.provide(layer),
        Effect.provide(
          Logger.layer(
            [Logger.make((options) => records.push(desktopLogRecord(options)))],
            { mergeWithExisting: false },
          ),
        ),
      );
    },
  );

  it.effect(
    "logs path error results and rejections while keeping success silent",
    () => {
      const records: DesktopLogRecord[] = [];
      return Effect.gen(function* () {
        const service = yield* ElectronShell;
        shell.openPath.mockResolvedValueOnce(
          "No application available for /private/file",
        );
        expect(yield* service.openPath("/private/file")).toBe(false);
        shell.openPath.mockRejectedValueOnce(new Error("OS rejected path"));
        expect(yield* service.openPath("/private/file")).toBe(false);
        expect(
          records.map(({ level, message, data }) => ({ level, message, data })),
        ).toEqual([
          {
            level: "warn",
            message: "Failed to open filesystem path",
            data: {},
          },
          {
            level: "warn",
            message: "Failed to open filesystem path",
            data: {},
          },
        ]);
        expect(records[0]?.repeatKey).toBe(
          "1ff5d2704a60068e09200a1e2496ff102a8701d39e71da2df23e16bdc07c0f7b",
        );
        expect(JSON.stringify(records)).not.toContain("/private/file");
        expect(records.map((record) => record.error?.[0]?.message)).toEqual([
          "No application available for [target]",
          "OS rejected path",
        ]);
        shell.openPath.mockResolvedValueOnce("");
        expect(yield* service.openPath("/private/file")).toBe(true);
        expect(records).toHaveLength(2);
      }).pipe(
        Effect.provide(layer),
        Effect.provide(
          Logger.layer(
            [Logger.make((options) => records.push(desktopLogRecord(options)))],
            { mergeWithExisting: false },
          ),
        ),
      );
    },
  );
});

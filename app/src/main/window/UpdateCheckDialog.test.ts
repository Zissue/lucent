import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { UpdateReleaseInfo, type UpdateCheckState } from "../../shared/updates";
import { showUpdateCheckDialog } from "./UpdateCheckDialog";

const availableUpdate: UpdateCheckState = {
  status: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  checkedAt: "2026-01-01T00:00:00.000Z",
  release: new UpdateReleaseInfo({
    version: "1.1.0",
    tagName: "v1.1.0",
    htmlUrl: "https://github.com/toommyliu/lucent/releases/tag/v1.1.0",
  }),
};

describe("showUpdateCheckDialog", () => {
  for (const quitting of [false, true]) {
    it.effect(`handles a cancelled sheet while quitting is ${quitting}`, () =>
      Effect.gen(function* () {
        const events: string[] = [];
        let isQuitting = false;
        const options = {
          mode: "automatic" as const,
          parentWindowId: 42,
          isQuitting: Effect.sync(() => isQuitting),
          dialog: {
            showMessageBox: () =>
              Effect.sync(() => {
                events.push("dialog");
                isQuitting = quitting;
                return { response: 1, checkboxChecked: false };
              }),
          },
          updates: {
            shouldPromptForAvailableRelease: () => Effect.succeed(true),
            skipAvailableRelease: (version: string) =>
              Effect.sync(() => {
                events.push(`skip:${version}`);
                return true;
              }),
            openReleasePage: Effect.succeed(true),
          },
        };

        yield* showUpdateCheckDialog(availableUpdate, options);

        expect(events).toEqual(
          quitting ? ["dialog"] : ["dialog", "skip:1.1.0"],
        );
      }),
    );
  }
});

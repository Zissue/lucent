import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeLifetime } from "../../window/RendererLifetimeTesting";
import { getGeneration } from "./gameRenderer";

it.effect("returns the generation resolved for the IPC sender", () =>
  Effect.gen(function* () {
    expect(
      yield* getGeneration.handler(undefined, {
        rendererId: 42,
        kind: "game",
        lifetime: makeLifetime(42, 7),
      }),
    ).toBe(7);
  }),
);

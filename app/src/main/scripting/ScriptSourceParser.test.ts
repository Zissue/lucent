import { readFile } from "node:fs/promises";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { normalizeScriptInputValues } from "@lucent/core/scriptInputs";

import { analyzeScriptSource } from "./ScriptSourceParser";

describe("ScriptSourceParser", () => {
  it.effect("finds only direct string-literal require calls", () =>
    Effect.gen(function* () {
      const analysis = yield* analyzeScriptSource(
        `
        require("./direct");
        require("./direct");
        const path = "./computed";
        require(path);
        const load = require;
        load("./aliased");
        require(\`./template\`);
      `,
        "fallback-script-id",
      );

      expect(analysis.requirements).toEqual(["./direct"]);
    }),
  );

  it.effect("extracts static inputs and fills a missing id", () =>
    Effect.gen(function* () {
      const { inputs: definition } = yield* analyzeScriptSource(
        `
        module.exports = function* run() {};
        module.exports.inputs = {
          fields: [
            {
              key: "enabled",
              type: "boolean",
              label: "Enabled",
              default: false,
            },
          ],
        };
      `,
        "fallback-script-id",
      );

      expect(definition).toEqual({
        id: "fallback-script-id",
        fields: [
          {
            key: "enabled",
            type: "boolean",
            label: "Enabled",
            default: false,
          },
        ],
      });
    }),
  );

  it.effect("discovers inputs for the shipped consumables script", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() =>
        readFile(
          new URL(
            "../../../../script-packages/lucent-consumables/scripts/get-consumables.js",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const { inputs: definition } = yield* analyzeScriptSource(
        source,
        "fallback-script-id",
      );

      expect(definition?.id).toBe("lucent-consumables");
      if (definition === null) return;
      expect(normalizeScriptInputValues(definition)).toEqual({
        potions: [],
        scrolls: ["Scroll of Enrage"],
        quantity: 100,
        potionMethod: "Buy",
        mode: "Farm",
        maxCrafts: 100,
        maxGold: 1000000,
      });
    }),
  );

  it.effect("extracts multi-select inputs", () =>
    Effect.gen(function* () {
      const { inputs: definition } = yield* analyzeScriptSource(
        `
        module.exports.inputs = {
          id: "multi-select",
          fields: [
            {
              key: "rewards",
              type: "multi-select",
              label: "Rewards",
              options: ["Weapon", "Armor", "Pet"],
              default: ["Weapon", "Armor"],
            },
          ],
        };
      `,
        "fallback-script-id",
      );

      expect(definition).toEqual({
        id: "multi-select",
        fields: [
          {
            key: "rewards",
            type: "multi-select",
            label: "Rewards",
            options: ["Weapon", "Armor", "Pet"],
            default: ["Weapon", "Armor"],
          },
        ],
      });
    }),
  );

  it.effect("discovers inputs for the shipped Wheel of Doom script", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() =>
        readFile(
          new URL(
            "../../../../script-packages/lucent-dailies/scripts/spin-wheel-of-doom.js",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const { inputs: definition } = yield* analyzeScriptSource(
        source,
        "fallback-script-id",
      );

      expect(definition?.id).toBe("lucent-dailies-spin-wheel-of-doom");
      if (definition === null) return;
      expect(normalizeScriptInputValues(definition)).toEqual({
        bankRewards: false,
      });
    }),
  );

  it.effect("rejects duplicate field keys", () =>
    Effect.gen(function* () {
      const error = yield* analyzeScriptSource(
        `
        module.exports.inputs = {
          id: "duplicate-fields",
          fields: [
            { key: "target", type: "string", label: "Target" },
            { key: "target", type: "string", label: "Target Again" },
          ],
        };
      `,
        "fallback-script-id",
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ScriptInputsExtractorError",
        operation: "validate",
        message: expect.stringContaining(
          "Script inputs definition is invalid:",
        ),
      });
    }),
  );

  it.effect("rejects dynamic, spread, and computed input definitions", () =>
    Effect.gen(function* () {
      const dynamic = yield* analyzeScriptSource(
        `
        const fields = [];
        module.exports.inputs = { id: "dynamic", fields };
      `,
        "fallback-script-id",
      ).pipe(Effect.flip);
      const spread = yield* analyzeScriptSource(
        `
        module.exports.inputs = { id: "spread", fields: [], ...extra };
      `,
        "fallback-script-id",
      ).pipe(Effect.flip);
      const computed = yield* analyzeScriptSource(
        `
        module.exports.inputs = { id: "computed", ["fields"]: [] };
      `,
        "fallback-script-id",
      ).pipe(Effect.flip);

      expect(dynamic).toMatchObject({
        operation: "static-evaluate",
        message: "Script inputs must be a static object expression.",
      });
      expect(spread).toMatchObject({
        operation: "static-evaluate",
        message: "Input objects cannot use spread properties.",
      });
      expect(computed).toMatchObject({
        operation: "static-evaluate",
        message: "Computed properties are not supported in inputs.",
      });
    }),
  );
});

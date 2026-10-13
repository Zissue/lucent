import { readFile } from "node:fs/promises";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { normalizeScriptInputValues } from "@lucent/core/scriptInputs";

import {
  ScriptInputsExtractor,
  ScriptInputsExtractorError,
  layer as scriptInputsExtractorLayer,
} from "./ScriptInputsExtractor";

const extractInputs = (source: string, fallbackId = "fallback-script-id") =>
  Effect.gen(function* () {
    const extractor = yield* ScriptInputsExtractor;
    return yield* extractor.extract(source, fallbackId);
  }).pipe(Effect.provide(scriptInputsExtractorLayer));

const analyzeSource = (source: string) =>
  Effect.gen(function* () {
    const extractor = yield* ScriptInputsExtractor;
    return yield* extractor.analyze(source, "fallback-script-id");
  }).pipe(Effect.provide(scriptInputsExtractorLayer));

const extractInputsResult = (source: string) =>
  extractInputs(source).pipe(
    Effect.match({
      onFailure: (error) => ({ error, ok: false }) as const,
      onSuccess: (value) => ({ ok: true, value }) as const,
    }),
  );

describe("ScriptInputsExtractor service", () => {
  it.effect("finds only direct string-literal require calls", () =>
    Effect.gen(function* () {
      const analysis = yield* analyzeSource(`
        require("./direct");
        require("./direct");
        const path = "./computed";
        require(path);
        const load = require;
        load("./aliased");
        require(\`./template\`);
      `);

      expect(analysis.requirements).toEqual(["./direct"]);
    }),
  );

  it.effect("extracts static inputs and fills a missing id", () =>
    Effect.gen(function* () {
      const definition = yield* extractInputs(`
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
      `);

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
            "../../../../../script-packages/lucent-consumables/scripts/get-consumables.js",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const definition = yield* extractInputs(source);

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
      const definition = yield* extractInputs(`
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
      `);

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
            "../../../../../script-packages/lucent-dailies/scripts/spin-wheel-of-doom.js",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const definition = yield* extractInputs(source);

      expect(definition?.id).toBe("lucent-dailies-spin-wheel-of-doom");
      if (definition === null) return;
      expect(normalizeScriptInputValues(definition)).toEqual({
        bankRewards: false,
      });
    }),
  );

  it.effect("rejects duplicate field keys", () =>
    Effect.gen(function* () {
      const result = yield* extractInputsResult(`
        module.exports.inputs = {
          id: "duplicate-fields",
          fields: [
            { key: "target", type: "string", label: "Target" },
            { key: "target", type: "string", label: "Target Again" },
          ],
        };
      `);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ScriptInputsExtractorError);
        expect(result.error).toMatchObject({
          operation: "validate",
          message: expect.stringContaining(
            "Script inputs definition is invalid:",
          ),
        });
      }
    }),
  );

  it.effect("rejects dynamic, spread, and computed input definitions", () =>
    Effect.gen(function* () {
      const dynamic = yield* extractInputsResult(`
        const fields = [];
        module.exports.inputs = { id: "dynamic", fields };
      `);
      const spread = yield* extractInputsResult(`
        module.exports.inputs = { id: "spread", fields: [], ...extra };
      `);
      const computed = yield* extractInputsResult(`
        module.exports.inputs = { id: "computed", ["fields"]: [] };
      `);

      expect(dynamic.ok).toBe(false);
      expect(spread.ok).toBe(false);
      expect(computed.ok).toBe(false);
    }),
  );
});

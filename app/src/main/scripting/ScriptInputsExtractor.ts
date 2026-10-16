import * as acorn from "acorn";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ScriptInputsDefinitionSchema,
  type ScriptInputsDefinition,
} from "@lucent/core/scriptInputs";

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const AstNodeSchema = Schema.Struct({ type: Schema.String });
const isUnknownRecord = Schema.is(UnknownRecordSchema);
const hasAstNodeShape = Schema.is(AstNodeSchema);
const decodeScriptInputsDefinition = Schema.decodeUnknownEffect(
  ScriptInputsDefinitionSchema,
  { onExcessProperty: "error" },
);

type AstNode = typeof AstNodeSchema.Type & Record<string, unknown>;

const inputExtractorOperationSchema = Schema.Literals([
  "parse",
  "static-evaluate",
  "validate",
]);

export class ScriptInputsExtractorError extends Schema.TaggedError<ScriptInputsExtractorError>()(
  "ScriptInputsExtractorError",
  {
    operation: inputExtractorOperationSchema,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ScriptInputsExtractorShape {
  readonly analyze: (
    source: string,
    fallbackId: string,
  ) => Effect.Effect<ScriptSourceAnalysis, ScriptInputsExtractorError>;
  readonly extract: (
    source: string,
    fallbackId: string,
  ) => Effect.Effect<ScriptInputsDefinition | null, ScriptInputsExtractorError>;
}

export class ScriptInputsExtractor extends Context.Service<
  ScriptInputsExtractor,
  ScriptInputsExtractorShape
>()("lucent/desktop/scripting/ScriptInputsExtractor") {}

export interface ScriptSourceAnalysis {
  readonly inputs: ScriptInputsDefinition | null;
  readonly requirements: readonly string[];
}

const isNode = (value: unknown): value is AstNode => hasAstNodeShape(value);

const staticError = (detail: string, cause?: unknown) =>
  new ScriptInputsExtractorError({
    operation: "static-evaluate",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const validationError = (cause: Schema.SchemaError) =>
  new ScriptInputsExtractorError({
    operation: "validate",
    detail: `Script inputs definition is invalid: ${cause.message}`,
    cause,
  });

const keyName = (property: AstNode): string => {
  const computed = property["computed"] === true;
  if (computed) {
    throw staticError("Computed properties are not supported in inputs.");
  }

  const key = property["key"];
  if (!isNode(key)) {
    throw staticError("Input object property key is invalid.");
  }

  if (key.type === "Identifier") {
    return String(key["name"]);
  }

  if (key.type === "Literal") {
    const value = key["value"];
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }

  throw staticError("Input object property key must be static.");
};

const evaluateStaticExpression = (node: AstNode): unknown => {
  switch (node.type) {
    case "ArrayExpression":
      return (node["elements"] as readonly unknown[]).map((element) => {
        if (!isNode(element)) {
          throw staticError("Input arrays cannot contain holes.");
        }
        return evaluateStaticExpression(element);
      });

    case "Literal":
      return node["value"];

    case "ObjectExpression": {
      const object: Record<string, unknown> = {};
      for (const rawProperty of node["properties"] as readonly unknown[]) {
        if (!isNode(rawProperty) || rawProperty.type === "SpreadElement") {
          throw staticError("Input objects cannot use spread properties.");
        }

        const name = keyName(rawProperty);
        if (Object.hasOwn(object, name)) {
          throw staticError(`Duplicate input object key: ${name}.`);
        }

        const value = rawProperty["value"];
        if (!isNode(value)) {
          throw staticError(`Input object property ${name} is invalid.`);
        }
        object[name] = evaluateStaticExpression(value);
      }
      return object;
    }

    default:
      throw staticError("Script inputs must be a static object expression.");
  }
};

const isModuleExportsInputsAssignment = (node: AstNode): boolean => {
  if (node.type !== "AssignmentExpression" || node["operator"] !== "=") {
    return false;
  }

  const left = node["left"];
  if (!isNode(left) || left.type !== "MemberExpression") {
    return false;
  }

  if (left["computed"] === true) {
    return false;
  }

  const property = left["property"];
  if (
    !isNode(property) ||
    property.type !== "Identifier" ||
    property["name"] !== "inputs"
  ) {
    return false;
  }

  const object = left["object"];
  if (!isNode(object) || object.type !== "MemberExpression") {
    return false;
  }

  if (object["computed"] === true) {
    return false;
  }

  const exportsProperty = object["property"];
  const moduleObject = object["object"];
  return (
    isNode(exportsProperty) &&
    exportsProperty.type === "Identifier" &&
    exportsProperty["name"] === "exports" &&
    isNode(moduleObject) &&
    moduleObject.type === "Identifier" &&
    moduleObject["name"] === "module"
  );
};

const findInputsExpression = (program: AstNode): Option.Option<AstNode> => {
  for (const statement of program["body"] as readonly unknown[]) {
    if (!isNode(statement) || statement.type !== "ExpressionStatement") {
      continue;
    }

    const expression = statement["expression"];
    if (isNode(expression) && isModuleExportsInputsAssignment(expression)) {
      const right = expression["right"];
      if (isNode(right)) {
        return Option.some(right);
      }
    }
  }

  return Option.none();
};

/** Finds direct require calls with one string-literal argument. */
const findLiteralRequirements = (program: AstNode): readonly string[] => {
  const requirements = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value)) return;

    if (value.type === "CallExpression") {
      const callee = value["callee"];
      const argumentsValue = value["arguments"];
      if (
        isNode(callee) &&
        callee.type === "Identifier" &&
        callee["name"] === "require" &&
        Array.isArray(argumentsValue) &&
        argumentsValue.length === 1
      ) {
        const argument = argumentsValue[0];
        if (
          isNode(argument) &&
          argument.type === "Literal" &&
          typeof argument["value"] === "string"
        ) {
          requirements.add(argument["value"]);
        }
      }
    }

    for (const child of Object.values(value)) visit(child);
  };

  visit(program);
  return [...requirements];
};

const normalizeInputDefinitionValue = (
  value: unknown,
  fallbackId: string,
): unknown => {
  if (!isUnknownRecord(value)) {
    return value;
  }

  const definition: Record<string, unknown> = { ...value };
  if (!Object.hasOwn(definition, "id")) {
    definition["id"] = fallbackId;
  }

  return definition;
};

const normalizeDefinition = (
  value: unknown,
  fallbackId: string,
): Effect.Effect<ScriptInputsDefinition, ScriptInputsExtractorError> =>
  decodeScriptInputsDefinition(
    normalizeInputDefinitionValue(value, fallbackId),
  ).pipe(Effect.mapError(validationError));

const parseSource = (
  source: string,
): Effect.Effect<AstNode, ScriptInputsExtractorError> =>
  Effect.try({
    try: () => {
      const options = {
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        ecmaVersion: "latest",
      } as const;
      try {
        return acorn.parse(source, {
          ...options,
          sourceType: "script",
        }) as unknown as AstNode;
      } catch {
        return acorn.parse(source, {
          ...options,
          sourceType: "module",
        }) as unknown as AstNode;
      }
    },
    catch: (cause) =>
      new ScriptInputsExtractorError({
        operation: "parse",
        detail: "Script source could not be parsed.",
        cause,
      }),
  });

export const analyzeScriptSource: ScriptInputsExtractorShape["analyze"] = (
  source,
  fallbackId,
) =>
  Effect.gen(function* () {
    const program = yield* parseSource(source);
    const requirements = findLiteralRequirements(program);
    const expression = findInputsExpression(program);
    if (Option.isNone(expression)) {
      return { inputs: null, requirements };
    }

    const value = yield* Effect.try({
      try: () => evaluateStaticExpression(expression.value),
      catch: (cause) =>
        cause instanceof ScriptInputsExtractorError
          ? cause
          : staticError(
              "Script inputs could not be statically evaluated.",
              cause,
            ),
    });

    const inputs = yield* normalizeDefinition(value, fallbackId);
    return { inputs, requirements };
  });

export const extractScriptInputs: ScriptInputsExtractorShape["extract"] = (
  source,
  fallbackId,
) =>
  analyzeScriptSource(source, fallbackId).pipe(
    Effect.map((analysis) => analysis.inputs),
  );

export const layer = Layer.succeed(
  ScriptInputsExtractor,
  ScriptInputsExtractor.of({
    analyze: analyzeScriptSource,
    extract: extractScriptInputs,
  }),
);

const { definePlugin, defineRule } = require("@oxlint/plugins");

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const EFFECT_RUNTIME_METHODS = new Set([
  "runCallback",
  "runFork",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
  "unsafeRunCallback",
  "unsafeRunPromise",
  "unsafeRunSync",
]);

const SCHEMA_COMPILER_METHODS = new Set([
  "is",
  "asserts",
  "decodeEffect",
  "decodeExit",
  "decodeOption",
  "decodePromise",
  "decodeResult",
  "decodeSync",
  "decodeUnknownEffect",
  "decodeUnknownExit",
  "decodeUnknownOption",
  "decodeUnknownPromise",
  "decodeUnknownResult",
  "decodeUnknownSync",
  "encodeEffect",
  "encodeExit",
  "encodeOption",
  "encodePromise",
  "encodeResult",
  "encodeSync",
  "encodeUnknownEffect",
  "encodeUnknownExit",
  "encodeUnknownOption",
  "encodeUnknownPromise",
  "encodeUnknownResult",
  "encodeUnknownSync",
]);

const getPropertyName = (property) => {
  if (
    property?.type === "Identifier" ||
    property?.type === "PrivateIdentifier"
  ) {
    return property.name;
  }
  if (
    (property?.type === "Literal" || property?.type === "StringLiteral") &&
    typeof property.value === "string"
  ) {
    return property.value;
  }
  return undefined;
};

const unwrapExpression = (node) => {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
};

const isUppercaseIdentifier = (node) => {
  if (node?.type !== "Identifier") {
    return false;
  }

  const [firstChar] = node.name;
  return firstChar !== undefined && firstChar.toUpperCase() === firstChar;
};

const getBannedRunner = (callee) => {
  const expression = unwrapExpression(callee);
  if (expression?.type !== "MemberExpression") {
    return undefined;
  }

  const object = unwrapExpression(expression.object);
  const propertyName = getPropertyName(expression.property);

  if (
    object?.type === "Identifier" &&
    object.name === "Effect" &&
    propertyName !== undefined &&
    EFFECT_RUNTIME_METHODS.has(propertyName)
  ) {
    return `Effect.${propertyName}`;
  }

  if (
    object?.type === "Identifier" &&
    object.name === "ManagedRuntime" &&
    propertyName === "make"
  ) {
    return "ManagedRuntime.make";
  }

  return undefined;
};

const getSchemaCompilerMethod = (callee) => {
  const expression = unwrapExpression(callee);
  if (expression?.type !== "MemberExpression") {
    return undefined;
  }

  const object = unwrapExpression(expression.object);
  const propertyName = getPropertyName(expression.property);

  return object?.type === "Identifier" &&
    object.name === "Schema" &&
    propertyName !== undefined &&
    SCHEMA_COMPILER_METHODS.has(propertyName)
    ? propertyName
    : undefined;
};

const isStaticSchemaReference = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type === "Identifier") {
    return isUppercaseIdentifier(expression);
  }

  if (expression?.type !== "MemberExpression") {
    return false;
  }

  const object = unwrapExpression(expression.object);
  return isUppercaseIdentifier(object) || isStaticSchemaReference(object);
};

const isNestedStaticSchemaCall = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "CallExpression") {
    return false;
  }

  const callee = unwrapExpression(expression.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }

  const object = unwrapExpression(callee.object);
  if (object?.type !== "Identifier" || object.name !== "Schema") {
    return false;
  }

  const method = getPropertyName(callee.property);
  if (method === "fromJsonString") {
    const [firstArg] = expression.arguments;
    return (
      isStaticSchemaReference(firstArg) || isNestedStaticSchemaCall(firstArg)
    );
  }

  return true;
};

const isImmediatelyInvoked = (node) => {
  const expression = unwrapExpression(node);
  const parent = unwrapExpression(expression?.parent);

  return (
    parent?.type === "CallExpression" &&
    unwrapExpression(parent.callee) === expression
  );
};

const noManualEffectRuntimeInTests = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow manual Effect runtime runners in tests; use @effect/vitest instead.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) {
      return {};
    }

    return {
      CallExpression(node) {
        const runner = getBannedRunner(node.callee);
        if (runner === undefined) {
          return;
        }

        context.report({
          node: node.callee,
          message: `Do not use ${runner} in tests. Use @effect/vitest with it.effect(...) or it.layer(...) instead.`,
        });
      },
    };
  },
});

const schemaCompilerMessage = (method, hasInlineSchema) =>
  hasInlineSchema
    ? `Hoist Schema.${method}(...) to module scope: both the inline schema and compiled function are rebuilt on every call.`
    : `Hoist Schema.${method}(...) to module scope: the compiled function is rebuilt on every call.`;

const noInlineSchemaCompile = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow inline Effect Schema decoder/encoder compiler calls inside function bodies.",
    },
  },
  create(context) {
    if (TEST_FILE_PATTERN.test(context.filename)) {
      return {};
    }

    let functionDepth = 0;

    const enterFunction = () => {
      functionDepth += 1;
    };
    const exitFunction = () => {
      functionDepth -= 1;
    };

    return {
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      CallExpression(node) {
        if (functionDepth === 0) {
          return;
        }

        const method = getSchemaCompilerMethod(node.callee);
        if (method === undefined || !isImmediatelyInvoked(node)) {
          return;
        }

        const [firstArg] = node.arguments;
        const hasInlineSchema = isNestedStaticSchemaCall(firstArg);
        if (!hasInlineSchema && !isStaticSchemaReference(firstArg)) {
          return;
        }

        context.report({
          node: node.callee,
          message: schemaCompilerMessage(method, hasInlineSchema),
        });
      },
    };
  },
});

const staticScriptInputs = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require script inputs to use a top-level module.exports.inputs assignment.",
    },
  },
  create(context) {
    return {
      AssignmentExpression(node) {
        const left = node.left;
        if (
          left.type !== "MemberExpression" ||
          getPropertyName(left.property) !== "inputs"
        ) {
          return;
        }

        const object = left.object;
        if (
          node.operator === "=" &&
          !left.computed &&
          object.type === "MemberExpression" &&
          !object.computed &&
          object.object.type === "Identifier" &&
          object.object.name === "module" &&
          object.property.type === "Identifier" &&
          object.property.name === "exports" &&
          node.parent.type === "ExpressionStatement" &&
          node.parent.parent.type === "Program" &&
          node.right.type === "ObjectExpression"
        ) {
          return;
        }

        context.report({
          node,
          message:
            "Define script inputs with a top-level module.exports.inputs = { ... } assignment. Lucent discovers inputs without executing the script and cannot read aliased or dynamic definitions.",
        });
      },
    };
  },
});

module.exports = definePlugin({
  meta: {
    name: "lucent",
  },
  rules: {
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "static-script-inputs": staticScriptInputs,
  },
});

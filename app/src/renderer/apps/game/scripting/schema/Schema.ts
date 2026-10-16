import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Native from "effect/Schema";
import * as Getter from "effect/SchemaGetter";

import {
  assertSync,
  decode,
  declare,
  definitionOf,
  field,
  INVALID,
  makeOptions,
  message,
  MISSING,
  missingOf,
  register,
  stateOf,
  validatePath,
  type Backend,
  type Definition,
} from "./engine";
import {
  flatten,
  fromIssues,
  issue,
  SchemaUsageError,
  ValidationError,
} from "./issues";
import type {
  CheckContext,
  Issue,
  IssueCode,
  IssueInput,
  Metadata,
  ParseOptions,
  ParseResult,
  RecoveryContext,
  RefineOptions,
} from "./public";

/** Base implementation keeps Effect and traversal state out of the scripting API. */
export class SchemaImpl<Output = unknown> {
  constructor(definition: Definition) {
    register(this, definition);
  }

  get description(): string | undefined {
    return definitionOf(this).description;
  }
  get metadata(): Metadata {
    return definitionOf(this).metadata;
  }

  parse(input: unknown, options?: ParseOptions): Output {
    const result = this.safeParse(input, options);
    if (!result.success) throw new ValidationError(result.issues);
    return result.data;
  }

  safeParse(input: unknown, options?: ParseOptions): ParseResult<Output> {
    const engineOptions = makeOptions(options);
    const result = decode(definitionOf(this).backend, input, engineOptions);
    return Result.isSuccess(result)
      ? { success: true, data: result.success as Output }
      : {
          success: false,
          issues: flatten(result.failure, {
            ...options,
            maxIssues:
              engineOptions.errors === "first"
                ? 1
                : stateOf(engineOptions).maxIssues,
          }),
        };
  }

  is(input: unknown): boolean {
    return Result.isSuccess(
      decode(definitionOf(this).backend, input, makeOptions()),
    );
  }

  optional(): SchemaImpl<Output | undefined> {
    const previous = definitionOf(this);
    return create({
      ...previous,
      missing: "omit",
      backend: declare((value, options) =>
        value === undefined
          ? Result.succeed(undefined)
          : decode(previous.backend, value, options),
      ),
    });
  }

  optionalKey(): SchemaImpl<Output> {
    return create({ ...definitionOf(this), missing: "omit" });
  }

  nullable(): SchemaImpl<Output | null> {
    const previous = definitionOf(this);
    return create({
      ...previous,
      literals:
        previous.literals === undefined
          ? undefined
          : Object.freeze([...new Set([...previous.literals, null])]),
      backend: declare((value, options) =>
        value === null
          ? Result.succeed(null)
          : decode(previous.backend, value, options),
      ),
    });
  }

  nullish(): SchemaImpl<Output | null | undefined> {
    return this.nullable().optional();
  }

  required(): SchemaImpl<Exclude<Output, undefined>> {
    return this.rejectValue(undefined, "A value is required.", "reject");
  }

  nonnullable(): SchemaImpl<Exclude<Output, null>> {
    return this.rejectValue(
      null,
      "Null is not allowed.",
      definitionOf(this).missing,
    );
  }

  private rejectValue<T extends null | undefined>(
    rejected: T,
    text: string,
    missing: Definition["missing"],
  ): SchemaImpl<Exclude<Output, T>> {
    const previous = definitionOf(this);
    return create({
      ...previous,
      missing,
      literals: previous.literals?.filter((value) => value !== rejected),
      backend: declare((value, options) => {
        if (value === rejected)
          return Result.fail(issue("invalid_value", text));
        const result = decode(previous.backend, value, options);
        return Result.isSuccess(result) && result.success === rejected
          ? Result.fail(issue("invalid_value", text))
          : result;
      }),
    });
  }

  default(fallback: unknown): SchemaImpl<Output> {
    const previous = definitionOf(this);
    return create({
      ...previous,
      missing: "parse",
      backend: declare((value, options) => {
        if (value === MISSING || value === undefined) {
          value = Predicate.isFunction(fallback)
            ? assertSync(fallback())
            : fallback;
        }
        return decode(previous.backend, value, options);
      }),
    });
  }

  catch(fallback: unknown): SchemaImpl<Output> {
    const previous = definitionOf(this);
    return create({
      ...previous,
      literals: undefined,
      missing: "parse",
      backend: declare((value, options) => {
        let result = field(previous, value, options);
        if (Result.isSuccess(result) && result.success === MISSING)
          result = decode(previous.backend, undefined, options);
        if (Result.isSuccess(result)) return result;
        const context: RecoveryContext = {
          input: value === MISSING ? undefined : value,
          issues: flatten(result.failure, {}, stateOf(options).path),
        };
        const replacement: unknown = Predicate.isFunction(fallback)
          ? assertSync(fallback(context))
          : fallback;
        return decode(previous.backend, replacement, options);
      }),
    });
  }

  refine(
    predicate: (value: Output) => boolean,
    options: RefineOptions = {},
  ): SchemaImpl<Output> {
    if (!Predicate.isFunction(predicate))
      throw new SchemaUsageError("A refinement requires a predicate.");
    const text = message(options, "The value does not satisfy this check.");
    const path = validatePath(options.path ?? []);
    if (options.rule !== undefined && typeof options.rule !== "string")
      throw new SchemaUsageError("A rule name must be a string.");
    return this.check((value, context) => {
      const accepted = assertSync(predicate(value));
      if (typeof accepted !== "boolean")
        throw new SchemaUsageError("A refinement must return a boolean.");
      if (!accepted)
        context.addIssue({
          message: text,
          path,
          ...(options.rule === undefined ? {} : { rule: options.rule }),
        });
    });
  }

  check(
    callback: (value: Output, context: CheckContext) => void,
  ): SchemaImpl<Output> {
    if (!Predicate.isFunction(callback))
      throw new SchemaUsageError("A check requires a callback.");
    return create({
      ...definitionOf(this),
      backend: this.checkedBackend((value, context) => {
        const result: unknown = assertSync(callback(value, context));
        if (result !== undefined)
          throw new SchemaUsageError(
            "A check callback must report issues and return undefined.",
          );
        return value;
      }),
    });
  }

  transform<Next>(
    callback: (value: Output, context: CheckContext) => Next,
  ): SchemaImpl<Exclude<Next, typeof INVALID>> {
    return create({
      ...definitionOf(this),
      backend: this.checkedBackend(callback),
    });
  }

  preprocess(
    callback: (value: unknown, context: CheckContext) => unknown,
  ): SchemaImpl<Output> {
    const previous = definitionOf(this);
    const preprocessing = create({
      backend: Native.Unknown,
      missing: "reject",
      metadata: previous.metadata,
    }).transform(callback);
    const preprocessingBackend = definitionOf(preprocessing).backend;
    const backend = declare((input, options) => {
      const result = decode(
        preprocessingBackend,
        input === MISSING ? undefined : input,
        options,
      );
      return Result.isFailure(result)
        ? result
        : decode(previous.backend, result.success, options);
    });
    return create({
      ...previous,
      missing: "parse",
      literals: undefined,
      backend,
    });
  }

  pipe(next: unknown): SchemaImpl {
    const previous = definitionOf(this);
    const target = definitionOf(next);
    return create({
      ...previous,
      missing: () => (missingOf(previous) === "reject" ? "reject" : "parse"),
      backend: declare((value, options) => {
        const result = field(previous, value, options);
        return Result.isFailure(result)
          ? result
          : field(target, result.success, options);
      }),
    });
  }

  brand(name: string): SchemaImpl<Output> {
    if (typeof name !== "string" || name.length === 0)
      throw new SchemaUsageError("A brand needs a nonempty name.");
    return create(definitionOf(this));
  }

  readonly(): SchemaImpl<Readonly<Output>> {
    return create(definitionOf(this));
  }

  describe(text: string): SchemaImpl<Output> {
    if (typeof text !== "string")
      throw new SchemaUsageError("A description must be a string.");
    return create({ ...definitionOf(this), description: text });
  }

  meta(metadata: Metadata): SchemaImpl<Output> {
    if (!Predicate.isObject(metadata))
      throw new SchemaUsageError("Metadata must be an object.");
    const previous = definitionOf(this);
    return create({
      ...previous,
      metadata: Object.freeze({ ...previous.metadata, ...metadata }),
    });
  }

  protected constraint(
    predicate: (value: Output) => boolean,
    code: IssueCode,
    text: string,
  ): Definition {
    const previous = definitionOf(this);
    const backend = previous.backend.check(
      Native.makeFilter(
        (value) => predicate(value as Output) || issue(code, text),
      ),
    );
    return { ...previous, backend };
  }

  protected converted(callback: (value: Output) => Output): Definition {
    const previous = definitionOf(this);
    return {
      ...previous,
      backend: previous.backend.pipe(
        Native.decodeTo(Native.Unknown, {
          decode: Getter.transform((value) => callback(value as Output)),
          encode: Getter.passthrough(),
        }),
      ),
    };
  }

  private checkedBackend(
    callback: (value: Output, context: CheckContext) => unknown,
  ): Backend {
    if (!Predicate.isFunction(callback))
      throw new SchemaUsageError("Expected a synchronous schema callback.");
    return definitionOf(this).backend.pipe(
      Native.decodeTo(Native.Unknown, {
        decode: Getter.transformEffect((value, options) => {
          const state = stateOf(options);
          const issues: Issue[] = [];
          let active = true;
          const context: CheckContext = Object.freeze({
            path: Object.freeze([...state.path]),
            addIssue: (entry: IssueInput) => {
              if (!active)
                throw new SchemaUsageError(
                  "A validation context cannot be used after its callback returns.",
                );
              if (
                !Predicate.isObject(entry as unknown) ||
                typeof entry.message !== "string" ||
                (entry.rule !== undefined && typeof entry.rule !== "string")
              ) {
                throw new SchemaUsageError(
                  "An issue needs a string message and an optional string rule.",
                );
              }
              if (
                issues.length >= state.maxIssues ||
                (state.errors === "first" && issues.length > 0)
              )
                return;
              issues.push({
                code: "custom",
                message: entry.message,
                path: validatePath(entry.path ?? []),
                ...(entry.rule === undefined ? {} : { rule: entry.rule }),
              });
            },
          });
          let result: unknown;
          try {
            result = assertSync(callback(value as Output, context));
          } finally {
            active = false;
          }
          if (result === INVALID && issues.length === 0)
            issues.push({
              code: "custom",
              message: "The value could not be transformed.",
              path: [],
            });
          return issues.length > 0
            ? Effect.fail(fromIssues(issues))
            : Effect.succeed(result);
        }),
        encode: Getter.passthrough(),
      }),
    );
  }
}

export const create = <T = unknown>(definition: Definition): SchemaImpl<T> => {
  const schema = new SchemaImpl<T>(definition);
  Object.freeze(schema);
  return schema;
};

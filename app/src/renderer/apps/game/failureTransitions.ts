import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { logFailure } from "../../../shared/logFailure";

export const makeFailureTransitions = Effect.fnUntraced(function* (options: {
  readonly component: string;
  readonly failed: string;
  readonly recovered: string;
}) {
  const failingKeys = yield* Ref.make<ReadonlySet<string>>(new Set());

  const failed = Effect.fnUntraced(function* (
    key: string,
    cause: Cause.Cause<unknown>,
    data: Readonly<Record<string, unknown>> = {},
  ) {
    if (Cause.hasInterruptsOnly(cause)) {
      return;
    }
    const changed = yield* Ref.modify(failingKeys, (keys) =>
      keys.has(key)
        ? ([false, keys] as const)
        : ([true, new Set([...keys, key])] as const),
    );
    if (changed) {
      yield* logFailure(options.failed, cause, { failure: "warning" }).pipe(
        Effect.annotateLogs({
          component: options.component,
          repeatKey: key,
          data: { ...data, key },
        }),
      );
    }
  });

  const recovered = Effect.fnUntraced(function* (
    key: string,
    data: Readonly<Record<string, unknown>> = {},
  ) {
    const changed = yield* Ref.modify(failingKeys, (keys) => {
      if (!keys.has(key)) {
        return [false, keys] as const;
      }
      const next = new Set(keys);
      next.delete(key);
      return [true, next] as const;
    });
    if (changed) {
      yield* Effect.logInfo(options.recovered).pipe(
        Effect.annotateLogs({
          component: options.component,
          repeatKey: key,
          data: { ...data, key },
        }),
      );
    }
  });

  const reset = (prefix: string) =>
    Ref.update(
      failingKeys,
      (keys) =>
        new Set(
          [...keys].filter(
            (key) => key !== prefix && !key.startsWith(`${prefix}/`),
          ),
        ),
    );

  return { failed, recovered, reset };
});

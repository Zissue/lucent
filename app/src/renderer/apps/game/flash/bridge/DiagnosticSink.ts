import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { makeDiagnostic, type DiagnosticPhase } from "../contract/Diagnostic";

export interface DiagnosticSinkService {
  readonly report: (
    phase: DiagnosticPhase,
    operation: string,
    cause: unknown,
    args?: readonly unknown[],
  ) => void;
}

const noop: DiagnosticSinkService = {
  report: () => undefined,
};

const debug: DiagnosticSinkService = {
  report: (phase, operation, cause, args) => {
    console.warn(
      "[flash:diagnostic]",
      makeDiagnostic(phase, operation, cause, args),
    );
  },
};

export class DiagnosticSink extends Context.Reference<DiagnosticSinkService>(
  "lucent/renderer/flash/DiagnosticSink",
  { defaultValue: () => noop },
) {}

export const noopLayer = Layer.succeed(DiagnosticSink, noop);
export const debugLayer = Layer.succeed(DiagnosticSink, debug);

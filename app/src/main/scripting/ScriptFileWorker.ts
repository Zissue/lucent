import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcServer } from "effect/rpc";
import { analyzeScriptFile } from "./ScriptFileAnalysis";
import { ScriptFileWorkerRpcs } from "./ScriptFileWorkerProtocol";

const handlers = ScriptFileWorkerRpcs.toLayer({
  ResolveScriptFile: ({ path }) => analyzeScriptFile(path),
});

RpcServer.layer(ScriptFileWorkerRpcs, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  Effect.runFork,
);

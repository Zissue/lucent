import { PositiveInt } from "@lucent/core";
import {
  FollowerConfigSchema,
  FollowerStateSchema,
} from "@lucent/core/follower";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentBoostDiscoverySchema } from "./environmentBoosts";
import {
  GrabbedDataSchema,
  LoaderGrabberGrabRequestSchema,
  LoaderGrabberLoadRequestSchema,
} from "./loader-grabber";
import { PacketQueuePayloadSchema, PacketSendPayloadSchema } from "./packets";

export class LoaderGrabberError extends Schema.TaggedError<LoaderGrabberError>()(
  "LoaderGrabberError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PacketsError extends Schema.TaggedError<PacketsError>()(
  "PacketsError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const LoaderGrabberRpcs = RpcGroup.make(
  Rpc.make("LoaderGrabberLoad", {
    payload: LoaderGrabberLoadRequestSchema,
    error: LoaderGrabberError,
  }),
  Rpc.make("LoaderGrabberGrab", {
    payload: LoaderGrabberGrabRequestSchema,
    success: Schema.NullOr(GrabbedDataSchema),
    error: LoaderGrabberError,
  }),
);

export const PacketsRpcs = RpcGroup.make(
  Rpc.make("PacketsStartCapture", { error: PacketsError }),
  Rpc.make("PacketsStopCapture", { error: PacketsError }),
  Rpc.make("PacketsSend", {
    payload: PacketSendPayloadSchema,
    error: PacketsError,
  }),
  Rpc.make("PacketsStartQueue", {
    payload: PacketQueuePayloadSchema,
    error: PacketsError,
  }),
  Rpc.make("PacketsStopQueue", { error: PacketsError }),
);

export const EnvironmentRpcs = RpcGroup.make(
  Rpc.make("EnvironmentFetchBoosts", {
    success: EnvironmentBoostDiscoverySchema,
  }),
  Rpc.make("EnvironmentWithdrawBoosts", {
    payload: { itemIds: Schema.Array(PositiveInt) },
    success: Schema.Array(PositiveInt),
  }),
);

export const FollowerRpcs = RpcGroup.make(
  Rpc.make("FollowerConfigure", {
    payload: FollowerConfigSchema,
    success: FollowerStateSchema,
  }),
  Rpc.make("FollowerGetState", { success: FollowerStateSchema }),
  Rpc.make("FollowerMe", { success: Schema.String }),
  Rpc.make("FollowerStart", {
    payload: FollowerConfigSchema,
    success: FollowerStateSchema,
  }),
  Rpc.make("FollowerStop", { success: FollowerStateSchema }),
);

export const GameRendererRpcs = RpcGroup.make().merge(
  EnvironmentRpcs,
  FollowerRpcs,
  LoaderGrabberRpcs,
  PacketsRpcs,
);

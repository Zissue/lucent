import * as Schema from "effect/Schema";

import {
  GrabbedDataSchema,
  LoaderGrabberGrabRequestSchema,
  LoaderGrabberLoadRequestSchema,
} from "../loader-grabber";
import { defineInvoke } from "./core";

const namespace = "desktop:loader-grabber";

export const LoaderGrabberIpc = {
  load: defineInvoke({
    channel: `${namespace}:load`,
    payload: LoaderGrabberLoadRequestSchema,
    result: Schema.Void,
  }),
  grab: defineInvoke({
    channel: `${namespace}:grab`,
    payload: LoaderGrabberGrabRequestSchema,
    result: Schema.NullOr(GrabbedDataSchema),
  }),
} as const;

import * as Scope from "effect/Scope";

import type { CloseableRendererLifetime } from "./DesktopWindows";

export const makeLifetime = (
  rendererId: number,
  generation = 1,
  scope = Scope.makeUnsafe(),
): CloseableRendererLifetime => ({
  rendererId,
  generation,
  scope,
  isCurrent: () => scope.state._tag !== "Closed",
});

import type { GameViewPresentation } from "../../../shared/gameViews";

const INACTIVE_FOCUSED_LAYOUT_FRAME_RATE_LIMIT = 2;
const INACTIVE_GRID_VIEW_FRAME_RATE_LIMIT = 8;

export const gameViewFrameRateLimit = (
  presentation: GameViewPresentation,
): number | null => {
  if (presentation.active && presentation.windowActive) return null;
  return presentation.layout === "grid"
    ? INACTIVE_GRID_VIEW_FRAME_RATE_LIMIT
    : INACTIVE_FOCUSED_LAYOUT_FRAME_RATE_LIMIT;
};

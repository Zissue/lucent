/** @jsxImportSource react */
import { Toaster, TooltipProvider } from "@lucent/ui-react";
import { useState } from "react";

import { selectDesktopBridge } from "../../../shared/desktopBridge";
import { Library } from "./Library";
import { useLoaderGrabber } from "./useLoaderGrabber";

export function App() {
  const [bridge] = useState(
    () => selectDesktopBridge(window.desktop, "loader-grabber").loaderGrabber,
  );
  const grabber = useLoaderGrabber(bridge);

  return (
    <TooltipProvider>
      <div className="lg-app">
        <Library grabber={grabber} />
      </div>
      <Toaster />
    </TooltipProvider>
  );
}

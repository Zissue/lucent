/** @jsxImportSource react */
import {
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Toaster,
  TooltipProvider,
  toast,
} from "@lucent/ui-react";
import { useEffect, useState } from "react";

import type { HotkeysPatch } from "@lucent/core/hotkeys";
import type {
  AppSettings,
  AppearancePatch,
  PreferencesPatch,
} from "@lucent/core/settings";
import {
  selectDesktopBridge,
  type AppPlatform,
} from "../../../shared/desktopBridge";
import type { UpdateCheckState } from "../../../shared/updates";
import { AppearancePane } from "./AppearancePane";
import { GeneralPane } from "./GeneralPane";
import { HotkeysPane } from "./HotkeysPane";
import { ResetAllButton } from "./SettingsLayout";

type SettingsPaneId = "general" | "appearance" | "hotkeys";

const PANES: readonly {
  readonly id: SettingsPaneId;
  readonly label: string;
}[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "hotkeys", label: "Shortcuts" },
];

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

export function App({
  initialSettings,
  platform,
}: {
  readonly initialSettings: AppSettings;
  readonly platform: AppPlatform;
}) {
  const desktop = selectDesktopBridge(window.desktop, "settings");
  const [settings, setSettings] = useState(initialSettings);
  const [updateState, setUpdateState] = useState<UpdateCheckState | null>(null);
  const [checking, setChecking] = useState(false);
  const [pane, setPane] = useState<SettingsPaneId>("general");

  useEffect(() => {
    const unsubscribeSettings = desktop.settings.onChanged(setSettings);
    const unsubscribeUpdates = desktop.updates.onChanged(setUpdateState);

    void desktop.settings
      .get()
      .then(setSettings)
      .catch((cause: unknown) => {
        console.error("Failed to load settings:", cause);
      });
    void desktop.updates
      .getState()
      .then((state) => setUpdateState((current) => current ?? state))
      .catch((cause: unknown) => {
        console.error("Failed to load update state:", cause);
      });

    return () => {
      unsubscribeSettings();
      unsubscribeUpdates();
    };
  }, [desktop]);

  const save = (update: () => Promise<AppSettings>): Promise<void> =>
    update()
      .then(setSettings)
      .catch((cause: unknown) => {
        console.error("Failed to update settings:", cause);
        toast.error("Couldn't save the change", {
          description: errorMessage(cause, "Try again."),
        });
      });

  const checkForUpdates = (): void => {
    setChecking(true);
    void desktop.updates
      .checkNow({ force: true })
      .then(setUpdateState)
      .catch((cause: unknown) => {
        console.error("Failed to check for updates:", cause);
        toast.error("Couldn't check for updates", {
          description: errorMessage(cause, "Try again later."),
        });
      })
      .finally(() => setChecking(false));
  };

  const openReleasePage = (): void => {
    void desktop.updates
      .openReleasePage()
      .then((opened) => {
        if (!opened) {
          toast.error("Couldn't open the release page");
        }
      })
      .catch((cause: unknown) => {
        console.error("Failed to open release page:", cause);
        toast.error("Couldn't open the release page");
      });
  };

  return (
    <TooltipProvider>
      <Tabs
        className="settings"
        onValueChange={(value: SettingsPaneId) => setPane(value)}
        value={pane}
      >
        <header className="settings__bar">
          <TabsList
            aria-label="Settings sections"
            className="settings__tabs"
            variant="underline"
          >
            {PANES.map((item) => (
              <TabsTab key={item.id} value={item.id}>
                {item.label}
              </TabsTab>
            ))}
          </TabsList>
          {pane === "appearance" ? (
            <ResetAllButton
              confirmLabel="Reset appearance"
              description="Mode, colors, fonts, rounding, and motion go back to their defaults."
              onConfirm={() => save(() => desktop.settings.resetAppearance())}
              title="Reset appearance?"
            />
          ) : pane === "hotkeys" ? (
            <ResetAllButton
              confirmLabel="Reset shortcuts"
              description="Every game window shortcut goes back to its default."
              onConfirm={() => save(() => desktop.settings.resetHotkeys())}
              title="Reset all shortcuts?"
            />
          ) : null}
        </header>
        <TabsPanel className="settings__panel" tabIndex={-1} value="general">
          <GeneralPane
            checking={checking || updateState?.status === "checking"}
            onCheckForUpdates={checkForUpdates}
            onOpenReleasePage={openReleasePage}
            onPreferencesPatch={(patch: PreferencesPatch) =>
              save(() => desktop.settings.updatePreferences(patch))
            }
            settings={settings}
            updateState={updateState}
          />
        </TabsPanel>
        <TabsPanel className="settings__panel" tabIndex={-1} value="appearance">
          <AppearancePane
            onAppearancePatch={(patch: AppearancePatch) =>
              save(() => desktop.settings.updateAppearance(patch))
            }
            settings={settings}
          />
        </TabsPanel>
        <TabsPanel className="settings__panel" tabIndex={-1} value="hotkeys">
          <HotkeysPane
            onHotkeysPatch={(patch: HotkeysPatch) =>
              save(() => desktop.settings.updateHotkeys(patch))
            }
            platform={platform}
            settings={settings}
          />
        </TabsPanel>
      </Tabs>
      <Toaster />
    </TooltipProvider>
  );
}

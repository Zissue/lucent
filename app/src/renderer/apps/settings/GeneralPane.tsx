/** @jsxImportSource react */
import {
  Button,
  Icon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@lucent/ui-react";

import type {
  AppLaunchMode,
  AppSettings,
  PreferencesPatch,
} from "@lucent/core/settings";
import { MAX_GAME_VIEWS_PER_WINDOW } from "../../../shared/gameViews";
import type { UpdateCheckState } from "../../../shared/updates";
import { SettingsGroup, SettingsPane, SettingsRow } from "./SettingsLayout";

const LAUNCH_MODES: readonly {
  readonly label: string;
  readonly value: AppLaunchMode;
}[] = [
  { label: "Game", value: "game" },
  { label: "Account Manager", value: "account-manager" },
];

const updateStatusText = (state: UpdateCheckState): string => {
  switch (state.status) {
    case "idle":
      return "Not checked yet";
    case "disabled":
      return "Automatic checks are off";
    case "checking":
      return "Checking for updates…";
    case "current":
      return "Up to date";
    case "available":
      return `Version ${state.latestVersion} is available`;
    case "error":
      return state.message;
  }
};

export function GeneralPane({
  checking,
  onCheckForUpdates,
  onOpenReleasePage,
  onPreferencesPatch,
  settings,
  updateState: reportedState,
}: {
  readonly checking: boolean;
  readonly onCheckForUpdates: () => void;
  readonly onOpenReleasePage: () => void;
  readonly onPreferencesPatch: (patch: PreferencesPatch) => void;
  readonly settings: AppSettings;
  readonly updateState: UpdateCheckState | null;
}) {
  const preferences = settings.preferences;
  const updateState =
    reportedState?.status === "disabled" && preferences.checkForUpdates
      ? {
          status: "idle" as const,
          currentVersion: reportedState.currentVersion,
        }
      : reportedState;
  const updateAvailable = updateState?.status === "available";

  return (
    <SettingsPane>
      <SettingsGroup title="Updates">
        <SettingsRow
          description="Checks when Lucent starts."
          label="Check for updates automatically"
        >
          {(control) => (
            <Switch
              {...control}
              checked={preferences.checkForUpdates}
              onCheckedChange={(checkForUpdates) =>
                onPreferencesPatch({ checkForUpdates })
              }
            />
          )}
        </SettingsRow>
        <SettingsRow
          description={
            <span
              className="settings-update-status"
              data-tone={
                checking
                  ? undefined
                  : updateState?.status === "error"
                    ? "error"
                    : updateAvailable
                      ? "available"
                      : undefined
              }
              role="status"
            >
              {checking
                ? "Checking for updates\u2026"
                : updateState === null
                  ? "\u00a0"
                  : updateStatusText(updateState)}
            </span>
          }
          label={
            updateState === null
              ? "Lucent"
              : `Lucent ${updateState.currentVersion}`
          }
        >
          {(control) =>
            updateAvailable ? (
              <Button
                aria-describedby={control["aria-describedby"]}
                key="release"
                onClick={onOpenReleasePage}
                size="sm"
                type="button"
                variant="primary"
              >
                View release
                <Icon icon="arrow_up_right" size="sm" />
              </Button>
            ) : (
              <Button
                aria-describedby={control["aria-describedby"]}
                key="check"
                loading={checking}
                onClick={onCheckForUpdates}
                size="sm"
                type="button"
              >
                Check now
              </Button>
            )
          }
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Startup">
        <SettingsRow
          description="The window Lucent opens when it starts."
          label="Open at startup"
        >
          {(control) => (
            <Select
              items={LAUNCH_MODES}
              onValueChange={(launchMode) => {
                if (launchMode !== null) {
                  onPreferencesPatch({ launchMode });
                }
              }}
              value={preferences.launchMode}
            >
              <SelectTrigger {...control} className="settings-select" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {LAUNCH_MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Game windows">
        <SettingsRow
          description={`Open up to ${MAX_GAME_VIEWS_PER_WINDOW} games as tabs in one window.`}
          label="Use tabs"
        >
          {(control) => (
            <Switch
              {...control}
              checked={preferences.useGameTabs}
              onCheckedChange={(useGameTabs) =>
                onPreferencesPatch({ useGameTabs })
              }
            />
          )}
        </SettingsRow>
        <SettingsRow
          description="With tabs, the title follows the selected tab."
          label="Show username in window titles"
        >
          {(control) => (
            <Switch
              {...control}
              checked={preferences.showGameUsernameInWindowTitle}
              onCheckedChange={(showGameUsernameInWindowTitle) =>
                onPreferencesPatch({ showGameUsernameInWindowTitle })
              }
            />
          )}
        </SettingsRow>
      </SettingsGroup>
    </SettingsPane>
  );
}

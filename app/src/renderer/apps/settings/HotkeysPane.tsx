/** @jsxImportSource react */
import {
  Badge,
  Icon,
  Kbd,
  KbdGroup,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@lucent/ui-react";
import { useEffect, useEffectEvent, useState } from "react";

import {
  SETTING_COMMAND_CATEGORIES,
  SETTINGS_COMMANDS,
  formatHotkeyDisplay,
  formatHotkeyDisplayParts,
  normalizeHotkeyBindingValue,
  readHotkeyBinding,
  type HotkeyBinding,
  type HotkeysPatch,
  type SettingsCommandDefinition,
  type SettingsCommandId,
} from "@lucent/core/hotkeys";
import type { AppSettings } from "@lucent/core/settings";
import type { AppPlatform } from "../../../shared/desktopBridge";
import { readHotkeyInputFromEvent } from "../../../shared/hotkeys";
import {
  ActionIconButton,
  SettingsGroup,
  SettingsPane,
} from "./SettingsLayout";

interface RowNotice {
  readonly commandId: SettingsCommandId;
  readonly message: string;
}

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

const COMMANDS_BY_CATEGORY = SETTING_COMMAND_CATEGORIES.map((category) => ({
  category,
  commands: SETTINGS_COMMANDS.filter(
    (command) => command.category === category,
  ),
}));

const conflictingLabels = (
  bindings: readonly HotkeyBinding[],
  id: SettingsCommandId,
  value: string,
): readonly string[] =>
  value === ""
    ? []
    : SETTINGS_COMMANDS.filter(
        (command) =>
          command.id !== id &&
          readHotkeyBinding(bindings, command.id) === value,
      ).map((command) => command.label);

function ConflictBadge({ labels }: { readonly labels: readonly string[] }) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`Also used by ${labels.join(", ")}`}
        className="hotkey-row__conflict"
      >
        <Badge size="sm" variant="warning">
          <Icon icon="triangle_alert" size="xs" />
          Conflict
        </Badge>
      </TooltipTrigger>
      <TooltipContent>Also used by {labels.join(", ")}</TooltipContent>
    </Tooltip>
  );
}

function HotkeyRow({
  bindings,
  command,
  notice,
  onClear,
  onRestoreDefault,
  onToggleRecording,
  platform,
  recording,
  recordingElsewhere,
}: {
  readonly bindings: readonly HotkeyBinding[];
  readonly command: SettingsCommandDefinition;
  readonly notice: string | null;
  readonly onClear: () => void;
  readonly onRestoreDefault: () => void;
  readonly onToggleRecording: () => void;
  readonly platform: AppPlatform;
  readonly recording: boolean;
  readonly recordingElsewhere: boolean;
}) {
  const value = readHotkeyBinding(bindings, command.id);
  const conflicts = conflictingLabels(bindings, command.id, value);
  const parts = formatHotkeyDisplayParts(value, platform);

  return (
    <div className="hotkey-row" data-recording={recording ? "" : undefined}>
      <div className="hotkey-row__label">
        <span>{command.label}</span>
        {conflicts.length > 0 ? <ConflictBadge labels={conflicts} /> : null}
      </div>
      <div className="hotkey-row__controls">
        <ActionIconButton
          hidden={value === command.defaultHotkey}
          icon="rotate_ccw"
          label={`Restore default shortcut for ${command.label}`}
          onClick={onRestoreDefault}
          tooltip="Reset"
        />
        <button
          aria-label={
            recording
              ? `Recording shortcut for ${command.label}. Press keys, Backspace to clear, or Escape to cancel.`
              : `${command.label} shortcut: ${formatHotkeyDisplay(value, platform)}. Change shortcut.`
          }
          aria-pressed={recording}
          className="hotkey-row__binding"
          disabled={recordingElsewhere}
          onClick={onToggleRecording}
          type="button"
        >
          {recording ? (
            <span className="hotkey-row__prompt">Press keys…</span>
          ) : value === "" ? (
            <span className="hotkey-row__unbound">Unbound</span>
          ) : (
            <KbdGroup>
              {parts.map((part, index) => (
                <Kbd key={`${index}-${part}`}>{part}</Kbd>
              ))}
            </KbdGroup>
          )}
        </button>
        <ActionIconButton
          hidden={value === ""}
          icon="x"
          label={`Clear shortcut for ${command.label}`}
          onClick={onClear}
          tooltip="Clear"
        />
      </div>
      {notice === null ? null : (
        <p className="hotkey-row__notice" role="status">
          <Icon icon="circle_alert" size="xs" />
          {notice}
        </p>
      )}
    </div>
  );
}

export function HotkeysPane({
  onHotkeysPatch,
  platform,
  settings,
}: {
  readonly onHotkeysPatch: (patch: HotkeysPatch) => void;
  readonly platform: AppPlatform;
  readonly settings: AppSettings;
}) {
  const bindings = settings.hotkeys.bindings;
  const [recordingId, setRecordingId] = useState<SettingsCommandId | null>(
    null,
  );
  const [notice, setNotice] = useState<RowNotice | null>(null);

  const commit = (id: SettingsCommandId, value: string | null): void => {
    const next =
      value ??
      SETTINGS_COMMANDS.find((command) => command.id === id)?.defaultHotkey ??
      "";
    const conflicts = conflictingLabels(bindings, id, next);
    if (conflicts.length > 0) {
      setNotice({
        commandId: id,
        message: `${value === null ? "The default is" : "Already"} used by ${conflicts.join(", ")}.`,
      });
      return;
    }
    setNotice(null);
    onHotkeysPatch({ bindings: [{ id, value }] });
  };

  const handleRecordingKeyDown = useEffectEvent(
    (id: SettingsCommandId, event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setNotice(null);
        setRecordingId(null);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        setRecordingId(null);
        commit(id, "");
        return;
      }

      if (MODIFIER_KEYS.has(event.key)) {
        return;
      }

      const normalized = normalizeHotkeyBindingValue(
        readHotkeyInputFromEvent(event),
      );
      if (normalized === null || normalized === "") {
        setNotice({ commandId: id, message: "Press a complete shortcut." });
        return;
      }

      setRecordingId(null);
      commit(id, normalized);
    },
  );

  useEffect(() => {
    if (recordingId === null) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void =>
      handleRecordingKeyDown(recordingId, event);
    const cancel = (): void => setRecordingId(null);

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("blur", cancel);
    };
  }, [recordingId]);

  const renderRow = (command: SettingsCommandDefinition) => (
    <HotkeyRow
      bindings={bindings}
      command={command}
      key={command.id}
      notice={notice?.commandId === command.id ? notice.message : null}
      onClear={() => commit(command.id, "")}
      onRestoreDefault={() => commit(command.id, null)}
      onToggleRecording={() => {
        setNotice(null);
        setRecordingId(recordingId === command.id ? null : command.id);
      }}
      platform={platform}
      recording={recordingId === command.id}
      recordingElsewhere={recordingId !== null && recordingId !== command.id}
    />
  );

  return (
    <SettingsPane description="Shortcuts only work in game windows.">
      {COMMANDS_BY_CATEGORY.map(({ category, commands }) => (
        <SettingsGroup key={category} title={category}>
          {commands.map(renderRow)}
        </SettingsGroup>
      ))}
    </SettingsPane>
  );
}

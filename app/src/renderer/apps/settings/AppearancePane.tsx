/** @jsxImportSource react */
import {
  ColorPicker,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  SliderControl,
  SliderThumb,
  Switch,
} from "@lucent/ui-react";
import { useState, type ReactNode } from "react";

import {
  hexToRgb,
  resolveThemeColors,
  resolveThemeVariant,
  rgbToHex,
} from "@lucent/core/appearance";
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_MONO_FONT,
  DEFAULT_SANS_FONT,
  THEME_COLOR_NAMES,
  THEME_FONT_SIZE_MAX,
  THEME_FONT_SIZE_MIN,
  THEME_ROUNDING_MAX,
  THEME_ROUNDING_MIN,
  type AppSettings,
  type AppearancePatch,
  type MotionMode,
  type ThemeColorName,
  type ThemeMode,
  type ThemeProfile,
  type ThemeProfilePatch,
  type ThemeRgb,
  type ThemeVariant,
} from "@lucent/core/settings";
import { resolveSystemPrefersDark } from "../../theme";
import {
  ActionIconButton,
  SettingsGroup,
  SettingsPane,
  SettingsRow,
  type RowControlProps,
} from "./SettingsLayout";

type ResolvedColors = Record<ThemeColorName, ThemeRgb>;
type ColorDrafts = Partial<
  Record<ThemeVariant, Partial<Record<ThemeColorName, ThemeRgb>>>
>;

const VARIANTS: readonly {
  readonly label: string;
  readonly value: ThemeVariant;
}[] = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const MODES: readonly { readonly label: string; readonly value: ThemeMode }[] =
  [
    { label: "Match system", value: "system" },
    { label: "Light", value: "light" },
    { label: "Dark", value: "dark" },
  ];

const MOTION_MODES: readonly {
  readonly label: string;
  readonly value: MotionMode;
}[] = [
  { label: "Match system", value: "system" },
  { label: "On", value: "on" },
  { label: "Off", value: "off" },
];

const COLOR_LABELS: Record<ThemeColorName, string> = {
  accent: "Accent",
  background: "Background",
  foreground: "Foreground",
};

const DEFAULT_PROFILE: ThemeProfile =
  DEFAULT_APP_SETTINGS.appearance.themes.dark;

const withRgb =
  (callback: (value: ThemeRgb) => void) =>
  (hex: string): void => {
    const rgb = hexToRgb(hex);
    if (rgb !== null) {
      callback(rgb);
    }
  };

function ColorCell({
  name,
  onCommit,
  onDraft,
  value,
  variant,
}: {
  readonly name: ThemeColorName;
  readonly onCommit: (value: ThemeRgb) => void;
  readonly onDraft: (value: ThemeRgb) => void;
  readonly value: ThemeRgb;
  readonly variant: ThemeVariant;
}) {
  const label = `${variant === "light" ? "Light" : "Dark"} ${COLOR_LABELS[name].toLowerCase()}`;
  return (
    <div className="color-cell">
      <ColorPicker
        aria-label={`${label} color`}
        onValueChange={withRgb(onDraft)}
        onValueCommitted={withRgb(onCommit)}
        size="sm"
        triggerLabel={`Choose ${label} color`}
        value={rgbToHex(value)}
      />
    </div>
  );
}

function FontInput({
  control,
  onCommit,
  placeholder,
  value,
}: {
  readonly control: RowControlProps;
  readonly onCommit: (value: string | null) => Promise<void>;
  readonly placeholder: string;
  readonly value: string | undefined;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const saved = value ?? "";
  const commit = (): void => {
    if (draft === null) {
      return;
    }
    const next = draft.trim();
    if (next === saved) {
      setDraft(null);
      return;
    }
    setDraft(next);
    void onCommit(next === "" ? null : next).finally(() => setDraft(null));
  };

  return (
    <Input
      {...control}
      className="settings-font-input"
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        } else if (event.key === "Escape") {
          setDraft(null);
        }
      }}
      onValueChange={setDraft}
      placeholder={placeholder}
      size="sm"
      spellCheck={false}
      title={draft ?? value ?? placeholder}
      value={draft ?? saved}
    />
  );
}

function FontSizeInput({
  control,
  onCommit,
  value,
}: {
  readonly control: RowControlProps;
  readonly onCommit: (value: number) => Promise<void>;
  readonly value: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) {
      return;
    }
    const parsed = Number(draft);
    const next = Math.min(
      THEME_FONT_SIZE_MAX,
      Math.max(THEME_FONT_SIZE_MIN, Math.round(parsed)),
    );
    if (draft.trim() === "" || !Number.isFinite(parsed) || next === value) {
      setDraft(null);
      return;
    }
    setDraft(String(next));
    void onCommit(next).finally(() => setDraft(null));
  };

  return (
    <span className="settings-size-input">
      <Input
        {...control}
        inputMode="numeric"
        max={THEME_FONT_SIZE_MAX}
        min={THEME_FONT_SIZE_MIN}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          } else if (event.key === "Escape") {
            setDraft(null);
          }
        }}
        onValueChange={setDraft}
        size="sm"
        step={1}
        type="number"
        value={draft ?? String(value)}
      />
      <span className="settings-size-input__unit">px</span>
    </span>
  );
}

function RoundingSlider({
  control,
  onCommit,
  value,
}: {
  readonly control: RowControlProps;
  readonly onCommit: (value: number) => Promise<void>;
  readonly value: number;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  return (
    <div className="rounding-control">
      <Slider
        className="rounding-control__slider"
        max={THEME_ROUNDING_MAX}
        min={THEME_ROUNDING_MIN}
        onValueChange={(next: number) => setDraft(next)}
        onValueCommitted={(next: number) => {
          if (next === value) {
            setDraft(null);
            return;
          }
          setDraft(next);
          void onCommit(next).finally(() => setDraft(null));
        }}
        step={0.05}
        value={shown}
      >
        <SliderControl>
          <SliderThumb
            aria-describedby={control["aria-describedby"]}
            aria-labelledby={control["aria-labelledby"]}
            getAriaValueText={(_formatted, next) =>
              `${Math.round(next * 100)}%`
            }
          />
        </SliderControl>
      </Slider>
      <output className="rounding-control__value">
        {Math.round(shown * 100)}%
      </output>
    </div>
  );
}

function ProfileRow({
  children,
  defaultValue,
  description,
  label,
  onReset,
  value,
}: {
  readonly children: (control: RowControlProps) => ReactNode;
  readonly defaultValue: number | string;
  readonly description?: string;
  readonly label: string;
  readonly onReset: () => void;
  readonly value: number | string;
}) {
  return (
    <SettingsRow description={description} label={label}>
      {(control) => (
        <div className="settings-control-with-reset">
          <ActionIconButton
            hidden={value === defaultValue}
            icon="rotate_ccw"
            label={`Reset ${label.toLowerCase()}`}
            onClick={onReset}
            tooltip="Reset"
          />
          {children(control)}
        </div>
      )}
    </SettingsRow>
  );
}

export function AppearancePane({
  onAppearancePatch,
  settings,
}: {
  readonly onAppearancePatch: (patch: AppearancePatch) => Promise<void>;
  readonly settings: AppSettings;
}) {
  const appearance = settings.appearance;
  const [drafts, setDrafts] = useState<{
    readonly settings: AppSettings;
    readonly values: ColorDrafts;
  }>({ settings, values: {} });
  const colorDrafts = drafts.settings === settings ? drafts.values : {};

  const colors: Record<ThemeVariant, ResolvedColors> = {
    light: { ...resolveThemeColors(settings, "light"), ...colorDrafts.light },
    dark: { ...resolveThemeColors(settings, "dark"), ...colorDrafts.dark },
  };

  const profile =
    appearance.themes[
      resolveThemeVariant(settings, resolveSystemPrefersDark())
    ];
  const shownVariants = VARIANTS.filter(
    ({ value }) =>
      appearance.themeMode === "system" || appearance.themeMode === value,
  );
  const isShown = (variant: ThemeVariant): boolean =>
    shownVariants.some(({ value }) => value === variant);
  const emptySlot = shownVariants.length === 1 ? <span /> : null;
  const isResettable = (variant: ThemeVariant, name: ThemeColorName): boolean =>
    isShown(variant) && appearance.themes[variant].colors[name] !== undefined;
  const resetColor = (name: ThemeColorName): void => {
    const themes: Partial<Record<ThemeVariant, ThemeProfilePatch>> = {};
    for (const { value: variant } of VARIANTS) {
      if (isResettable(variant, name)) {
        themes[variant] = { colors: { [name]: null } };
      }
    }
    void onAppearancePatch({ themes });
  };

  const draftColor = (
    variant: ThemeVariant,
    name: ThemeColorName,
    value: ThemeRgb,
  ): void =>
    setDrafts({
      settings,
      values: {
        ...colorDrafts,
        [variant]: { ...colorDrafts[variant], [name]: value },
      },
    });

  const patchColor = (
    variant: ThemeVariant,
    name: ThemeColorName,
    value: ThemeRgb,
  ): Promise<void> =>
    onAppearancePatch({ themes: { [variant]: { colors: { [name]: value } } } });

  const patchProfiles = (patch: ThemeProfilePatch): Promise<void> =>
    onAppearancePatch({ themes: { light: patch, dark: patch } });

  return (
    <SettingsPane>
      <SettingsGroup
        action={
          shownVariants.length > 1
            ? shownVariants.map((variant) => (
                <span
                  aria-hidden
                  className="color-group__column"
                  key={variant.value}
                >
                  {variant.label}
                </span>
              ))
            : undefined
        }
        className="color-group"
        title="Theme"
      >
        <SettingsRow label="Mode">
          {(control) => (
            <Select
              items={MODES}
              onValueChange={(themeMode) => {
                if (themeMode !== null) {
                  void onAppearancePatch({ themeMode });
                }
              }}
              value={appearance.themeMode}
            >
              <SelectTrigger {...control} className="settings-select" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
        <div className="color-grid" data-variants={shownVariants.length}>
          {THEME_COLOR_NAMES.map((name) => (
            <div className="color-grid__row" key={name}>
              <div className="color-grid__label">
                <span className="settings-row__label">
                  {COLOR_LABELS[name]}
                </span>
                <ActionIconButton
                  hidden={
                    !VARIANTS.some(({ value: variant }) =>
                      isResettable(variant, name),
                    )
                  }
                  icon="rotate_ccw"
                  label={`Reset ${COLOR_LABELS[name].toLowerCase()} color`}
                  onClick={() => resetColor(name)}
                  tooltip="Reset"
                />
              </div>
              {emptySlot}
              {shownVariants.map(({ value: variant }) => (
                <ColorCell
                  key={variant}
                  name={name}
                  onCommit={(value) =>
                    void patchColor(variant, name, value).finally(() =>
                      setDrafts((current) => ({ ...current, values: {} })),
                    )
                  }
                  onDraft={(value) => draftColor(variant, name, value)}
                  value={colors[variant][name]}
                  variant={variant}
                />
              ))}
            </div>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Text">
        <ProfileRow
          defaultValue=""
          label="Interface font"
          onReset={() => patchProfiles({ sansFont: null })}
          value={profile.sansFont ?? ""}
        >
          {(control) => (
            <FontInput
              control={control}
              onCommit={(sansFont) => patchProfiles({ sansFont })}
              placeholder={DEFAULT_SANS_FONT}
              value={profile.sansFont}
            />
          )}
        </ProfileRow>
        <ProfileRow
          defaultValue={DEFAULT_PROFILE.sansFontSize}
          label="Interface font size"
          onReset={() =>
            patchProfiles({ sansFontSize: DEFAULT_PROFILE.sansFontSize })
          }
          value={profile.sansFontSize}
        >
          {(control) => (
            <FontSizeInput
              control={control}
              onCommit={(sansFontSize) => patchProfiles({ sansFontSize })}
              value={profile.sansFontSize}
            />
          )}
        </ProfileRow>
        <ProfileRow
          defaultValue=""
          label="Code font"
          onReset={() => patchProfiles({ monoFont: null })}
          value={profile.monoFont ?? ""}
        >
          {(control) => (
            <FontInput
              control={control}
              onCommit={(monoFont) => patchProfiles({ monoFont })}
              placeholder={DEFAULT_MONO_FONT}
              value={profile.monoFont}
            />
          )}
        </ProfileRow>
        <ProfileRow
          defaultValue={DEFAULT_PROFILE.monoFontSize}
          label="Code font size"
          onReset={() =>
            patchProfiles({ monoFontSize: DEFAULT_PROFILE.monoFontSize })
          }
          value={profile.monoFontSize}
        >
          {(control) => (
            <FontSizeInput
              control={control}
              onCommit={(monoFontSize) => patchProfiles({ monoFontSize })}
              value={profile.monoFontSize}
            />
          )}
        </ProfileRow>
      </SettingsGroup>

      <SettingsGroup title="Interface">
        <ProfileRow
          defaultValue={DEFAULT_PROFILE.rounding}
          description="Applies to most elements."
          label="Rounding"
          onReset={() => patchProfiles({ rounding: DEFAULT_PROFILE.rounding })}
          value={profile.rounding}
        >
          {(control) => (
            <RoundingSlider
              control={control}
              onCommit={(rounding) => patchProfiles({ rounding })}
              value={profile.rounding}
            />
          )}
        </ProfileRow>
        <SettingsRow
          description="Minimizes animations across the interface."
          label="Reduce motion"
        >
          {(control) => (
            <Select
              items={MOTION_MODES}
              onValueChange={(reduceMotion) => {
                if (reduceMotion !== null) {
                  void onAppearancePatch({ reduceMotion });
                }
              }}
              value={appearance.reduceMotion}
            >
              <SelectTrigger {...control} className="settings-select" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {MOTION_MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
        <SettingsRow
          description="Show a hand cursor over clickable controls."
          label="Pointer cursors"
        >
          {(control) => (
            <Switch
              {...control}
              checked={appearance.useCursorPointers}
              onCheckedChange={(useCursorPointers) =>
                onAppearancePatch({ useCursorPointers })
              }
            />
          )}
        </SettingsRow>
      </SettingsGroup>
    </SettingsPane>
  );
}

/** @jsxImportSource react */
import {
  Button,
  Icon,
  IconButton,
  Input,
  Label,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@lucent/ui-react";
import {
  useId,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import type {
  EnvironmentAutomationCapability,
  EnvironmentState,
} from "@lucent/core/environment";
import type { DesktopEnvironmentBridge } from "../../../shared/desktopBridge";
import { useInlineEdit } from "./useInlineEdit";

export type EnvironmentUpdate = (
  request: () => Promise<EnvironmentState>,
) => Promise<EnvironmentState | null>;

export const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

export interface EnvironmentSectionProps {
  readonly environment: DesktopEnvironmentBridge;
  readonly setError: Dispatch<SetStateAction<string>>;
  readonly state: EnvironmentState;
  readonly update: EnvironmentUpdate;
}

export function SheetSection({
  actions,
  children,
  count,
  id,
  title,
}: {
  readonly actions: ReactNode;
  readonly children: ReactNode;
  readonly count: number;
  readonly id: EnvironmentAutomationCapability;
  readonly title: string;
}) {
  const headingId = `environment-section-${id}`;
  return (
    <section aria-labelledby={headingId} className="environment-section">
      <div className="environment-section__heading">
        <div className="environment-section__label">
          <h2 className="environment-section__title" id={headingId}>
            {title}
          </h2>
          <span className="environment-count">{count}</span>
        </div>
        <div className="environment-section__actions">{actions}</div>
      </div>
      {children}
    </section>
  );
}

export function AutomationSwitch({
  checked,
  label,
  onCheckedChange,
  tooltip,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Label className="environment-automation" />}>
        <Switch
          aria-label={`Automate ${label}`}
          checked={checked}
          onCheckedChange={onCheckedChange}
          size="sm"
        />
        Automate
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function ClearButton({
  disabled,
  label,
  onClick,
}: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Button
      aria-label={`Clear ${label}`}
      className="environment-clear-action"
      disabled={disabled}
      onClick={onClick}
      size="sm"
      variant="ghost"
    >
      Clear
    </Button>
  );
}

export function RuleGroup({
  children,
  help,
  label,
}: {
  readonly children: ReactNode;
  readonly help?: { readonly label: string; readonly text: string };
  readonly label: string;
}) {
  const labelId = useId();
  return (
    <div aria-labelledby={labelId} className="environment-rules" role="group">
      <span className="environment-rules__label">
        <span id={labelId}>{label}</span>
        {help === undefined ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={help.label}
                  className="environment-help"
                  size="sm"
                  square
                  variant="ghost"
                />
              }
            >
              <Icon icon="info" size="sm" />
            </TooltipTrigger>
            <TooltipContent className="environment-help__content">
              {help.text}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
      <div className="environment-rules__pills">{children}</div>
    </div>
  );
}

export function TogglePill({
  children,
  danger = false,
  onPressedChange,
  pressed,
}: {
  readonly children: ReactNode;
  readonly danger?: boolean;
  readonly onPressedChange: (pressed: boolean) => void;
  readonly pressed: boolean;
}) {
  return (
    <button
      aria-pressed={pressed}
      className="environment-toggle-pill"
      data-danger={danger ? "" : undefined}
      onClick={() => onPressedChange(!pressed)}
      type="button"
    >
      <Icon icon={pressed ? "check" : "plus"} size="xs" />
      {children}
    </button>
  );
}

export function EntryForm({
  label,
  onAdd,
  placeholder,
}: {
  readonly label: string;
  readonly onAdd: (value: string) => string | null;
  readonly placeholder: string;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  return (
    <form
      className="environment-entry"
      onSubmit={(event) => {
        event.preventDefault();
        const nextError = onAdd(value);
        setError(nextError);
        if (nextError === null) {
          setValue("");
        }
      }}
    >
      <Input
        aria-describedby={hintId}
        aria-invalid={error !== null || undefined}
        aria-label={label}
        autoComplete="off"
        data-invalid={error === null ? undefined : ""}
        onValueChange={(next) => {
          setValue(next);
          setError(null);
        }}
        placeholder={placeholder}
        size="sm"
        spellCheck={false}
        value={value}
      />
      <IconButton
        disabled={value.trim() === ""}
        label={label}
        size="sm"
        type="submit"
        variant="secondary"
      >
        <Icon icon="plus" size="sm" />
      </IconButton>
      <p
        className="environment-entry__hint"
        data-error={error === null ? undefined : ""}
        id={hintId}
      >
        {error ?? "Separate entries with semicolons."}
      </p>
    </form>
  );
}

export function TagList({
  children,
  count,
  emptyText,
}: {
  readonly children: ReactNode;
  readonly count: number;
  readonly emptyText: string;
}) {
  return (
    <ul className="environment-tags">
      {count === 0 ? <li className="environment-empty">{emptyText}</li> : null}
      {children}
    </ul>
  );
}

export function NameTag({
  children,
  name,
  onRename,
}: {
  readonly children: ReactNode;
  readonly name: string;
  readonly onRename: (name: string) => void;
}) {
  const edit = useInlineEdit({
    commit: (value) => {
      const next = value.trim();
      if (next !== "" && next !== name) {
        onRename(next);
      }
      return "saved";
    },
    initialValue: () => name,
  });

  return (
    <li
      className="environment-tag"
      data-editing={edit.editing ? "" : undefined}
    >
      {edit.editing ? (
        <input
          {...edit.inputProps}
          aria-label={`Rename ${name}`}
          autoComplete="off"
          className="environment-tag__input"
          spellCheck={false}
        />
      ) : (
        <>
          <button
            aria-label={`Rename ${name}`}
            className="environment-tag__label"
            onDoubleClick={edit.start}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "F2") {
                event.preventDefault();
                edit.start();
              }
            }}
            ref={edit.triggerRef}
            title={name}
            type="button"
          >
            {name}
          </button>
          {children}
        </>
      )}
    </li>
  );
}

export function RemoveButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <IconButton
      className="environment-tag__button environment-tag__remove"
      label={label}
      onClick={onClick}
      size="sm"
      tooltip={false}
    >
      <Icon icon="x" size="sm" />
    </IconButton>
  );
}

/** @jsxImportSource react */
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  type ButtonVariant,
} from "@lucent/ui-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  createEmptyEnvironmentState,
  type EnvironmentAutomationCapability,
  type EnvironmentState,
} from "@lucent/core/environment";
import { selectDesktopBridge } from "../../../shared/desktopBridge";
import { BoostsSection } from "./BoostsSection";
import { DropsSection } from "./DropsSection";
import {
  errorMessage,
  type EnvironmentSectionProps,
  type EnvironmentUpdate,
} from "./EnvironmentLayout";
import { QuestsSection } from "./QuestsSection";

type EnvironmentFilter = "all" | EnvironmentAutomationCapability;

const SECTIONS: readonly {
  readonly id: EnvironmentAutomationCapability;
  readonly label: string;
  readonly count: (state: EnvironmentState) => number;
  readonly Section: (props: EnvironmentSectionProps) => ReactNode;
}[] = [
  {
    count: (state) => state.itemNames.length,
    id: "drops",
    label: "Drops",
    Section: DropsSection,
  },
  {
    count: (state) => state.questIds.length,
    id: "quests",
    label: "Quests",
    Section: QuestsSection,
  },
  {
    count: (state) => state.boosts.length,
    id: "boosts",
    label: "Boosts",
    Section: BoostsSection,
  },
];

function FilterPill({
  count,
  label,
  onSelect,
  pressed,
}: {
  readonly count: number;
  readonly label: string;
  readonly onSelect: () => void;
  readonly pressed: boolean;
}) {
  return (
    <button
      aria-pressed={pressed}
      className="environment-filter-pill"
      onClick={onSelect}
      type="button"
    >
      {label}
      <span className="environment-count">{count}</span>
    </button>
  );
}

function ConfirmButton({
  busyLabel,
  busy = false,
  confirmLabel,
  description,
  disabled = false,
  label,
  onConfirm,
  title,
  tooltip,
  variant,
}: {
  readonly busyLabel?: string;
  readonly busy?: boolean;
  readonly confirmLabel: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onConfirm: () => void;
  readonly title: string;
  readonly tooltip: string;
  readonly variant: ButtonVariant;
}) {
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger
          render={
            <AlertDialogTrigger
              render={
                <Button
                  aria-busy={busy || undefined}
                  disabled={disabled || busy}
                  size="sm"
                  type="button"
                  variant={variant}
                />
              }
            />
          }
        >
          {busy && busyLabel !== undefined ? busyLabel : label}
        </TooltipTrigger>
        <TooltipContent className="environment-header__tooltip">
          {tooltip}
        </TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button size="sm" type="button" />}>
            Cancel
          </AlertDialogClose>
          <AlertDialogClose
            onClick={onConfirm}
            render={<Button size="sm" type="button" variant="danger" />}
          >
            {confirmLabel}
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function App() {
  const environment = selectDesktopBridge(
    window.desktop,
    "environment",
  ).environment;
  const [state, setState] = useState<EnvironmentState>(
    createEmptyEnvironmentState,
  );
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [filter, setFilter] = useState<EnvironmentFilter>("all");
  const [clearing, setClearing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = (): Promise<void> =>
    environment.getState().then(
      (next) => {
        setState(next);
        setLoadFailed(false);
        setError("");
      },
      (cause: unknown) => {
        console.error("Failed to load environment state:", cause);
        setLoadFailed(true);
        setError(errorMessage(cause, "Couldn't load this Environment."));
      },
    );

  useEffect(() => {
    const unsubscribe = environment.onChanged(setState);
    void load().finally(() => {
      document.documentElement.dataset["ready"] = "true";
    });
    return unsubscribe;
  }, [environment]);

  const update: EnvironmentUpdate = (request) => {
    setError("");
    setLoadFailed(false);
    return request().then(
      (next) => {
        setState(next);
        return next;
      },
      (cause: unknown) => {
        console.error("Environment update failed:", cause);
        setError(errorMessage(cause, "Couldn't save the change. Try again."));
        return null;
      },
    );
  };

  const runBusy = (
    setBusy: (busy: boolean) => void,
    request: () => Promise<EnvironmentState>,
  ): void => {
    setBusy(true);
    void update(request).finally(() => setBusy(false));
  };

  const totalCount = SECTIONS.reduce(
    (total, section) => total + section.count(state),
    0,
  );
  const sectionProps = { environment, setError, state, update };

  return (
    <TooltipProvider>
      <div className="environment">
        <header className="environment-header">
          <div
            aria-label="Show sections"
            className="environment-filter"
            role="group"
          >
            <FilterPill
              count={totalCount}
              label="All"
              onSelect={() => setFilter("all")}
              pressed={filter === "all"}
            />
            {SECTIONS.map((section) => (
              <FilterPill
                count={section.count(state)}
                key={section.id}
                label={section.label}
                onSelect={() => setFilter(section.id)}
                pressed={filter === section.id}
              />
            ))}
          </div>
          <div className="environment-header__actions">
            <ConfirmButton
              confirmLabel="Clear Environment"
              description="This removes every drop, quest, and boost from this Environment, including drop sounds. Automation and drop rules stay as they are."
              disabled={clearing || totalCount === 0}
              label="Clear all"
              onConfirm={() => runBusy(setClearing, () => environment.clear())}
              title="Clear this Environment?"
              tooltip="Remove every drop, quest, and boost from this Environment."
              variant="secondary"
            />
            <ConfirmButton
              busy={syncing}
              busyLabel="Applying…"
              confirmLabel="Apply to all"
              description="This replaces every other Environment's automation, rules, and lists with this Environment's. This can't be undone."
              label="Apply to all"
              onConfirm={() =>
                runBusy(setSyncing, () => environment.syncToAll())
              }
              title="Apply to all Environments?"
              tooltip="Copy this Environment's automation, rules, and lists to every other Environment, replacing what's already there."
              variant="primary"
            />
          </div>
        </header>

        {error === "" ? null : (
          <div className="environment-notice">
            <Alert className="environment-error" variant="danger">
              <AlertDescription>{error}</AlertDescription>
              {loadFailed ? (
                <AlertActions>
                  <Button onClick={() => void load()} size="sm" type="button">
                    Retry
                  </Button>
                </AlertActions>
              ) : null}
            </Alert>
          </div>
        )}

        <div className="environment-sheet">
          {SECTIONS.filter(
            (section) => filter === "all" || filter === section.id,
          ).map(({ id, Section }) => (
            <Section key={id} {...sectionProps} />
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}

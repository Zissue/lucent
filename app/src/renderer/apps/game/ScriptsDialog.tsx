import { displayScriptSourceText } from "./scripting/scriptSourceAttribution";
import { createVirtualizer } from "@tanstack/solid-virtual";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  Field,
  Icon,
  IconButton,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipIconButton,
  TooltipTrigger,
  type AlertVariant,
  type ButtonProps,
  type ButtonVariant,
  type IconButtonProps,
  type IconName,
} from "@lucent/ui";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
  untrack,
} from "solid-js";

import type { RoomPolicy } from "@lucent/core/accountSettings";
import {
  isScriptPackageRepositorySubdirectory,
  type GitHubCredentialSummary,
  type ScriptCatalogEntry,
  type ScriptCatalogOverview,
  type ScriptPackageInstallRequest,
  type ScriptPackageLeftoverCopy,
  type ScriptPackageDependencyIssue,
  type ScriptPackageMutationResult,
  type ScriptPackageSummary,
  type ScriptReference,
  type ValidScriptPackage,
} from "@lucent/core/scriptPackages";
import type { DesktopScriptingBridge } from "../../../shared/desktopBridge";
import type {
  ScriptQueueRunItem,
  ScriptQueueState,
} from "./scripting/ScriptQueue";
import { ScriptQueueList, type ScriptQueueListApi } from "./ScriptQueueList";
import { parseGitHubRepositoryInput } from "../../../shared/githubRepositoryUrl";
import {
  parseRoomNumberInput,
  roomNumberKind,
  type RoomPolicyMode,
} from "./scripting/roomPolicyInput";
import {
  activeScriptPackageRateLimits,
  formatScriptPackageRetryLabel,
  scriptPackageCredentialRateLimitScope,
  scriptPackageRateLimit,
  scriptPackageRateLimitTiming,
  scriptPackagesEligibleForUpdateCheck,
  type ActiveScriptPackageRateLimit,
} from "./scriptPackageRateLimit";
import {
  SCRIPT_CATALOG_PAGE_SIZE,
  groupScriptCatalogPageOffsets,
  scriptCatalogEntryAt,
  scriptCatalogPageOffsetsForRange,
  storeScriptCatalogPageRange,
  touchScriptCatalogPages,
  type ScriptCatalogPageCache,
} from "./scriptCatalogPages";
import { confirmScriptPackageRemoval } from "./scriptPackageRemoval";
import { refreshScriptPackageLeftovers } from "./scriptPackageLeftovers";
import {
  checkScriptPackageUpdatesSerially,
  formatScriptPackageUpdateCheckFailures,
} from "./scriptPackageUpdateCheck";
import {
  scriptContextCharacterLimit,
  truncatePathContext,
} from "./scriptPathDisplay";

const SCRIPT_ROW_HEIGHT = 40;
const QUEUE_ADDED_FEEDBACK_DURATION_MS = 1_200;
const QUEUE_BADGE_MAX_COUNT = 99;
const GITHUB_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new";
const GITHUB_TOKEN_USE_HINT =
  "Use a token for private repositories or higher GitHub API rate limits.";
const INSTALL_ADVANCED_OPTIONS_HINT_ID = "script-package-install-options-hint";
const GITHUB_TOKEN_LABEL_FEEDBACK_ID =
  "script-package-credential-label-feedback";
const GITHUB_TOKEN_VALUE_FEEDBACK_ID =
  "script-package-credential-token-feedback";

const roomPolicyLabels: Record<RoomPolicyMode, string> = {
  public: "Public rooms",
  "random-private": "Random private room",
  specific: "Specific room",
};

export type ScriptsDialogTab = "options" | "packages" | "queue" | "scripts";
type ScrollableScriptsDialogTab = Extract<
  ScriptsDialogTab,
  "packages" | "scripts"
>;
export type PackageManagementView =
  | "credentials"
  | "details"
  | "install"
  | "installed";
type PackageCollectionView = Extract<
  PackageManagementView,
  "details" | "installed"
>;
type PackageTaskState =
  | { readonly view: "closed" }
  | { readonly view: "install" }
  | { readonly view: "tokens" }
  | {
      readonly returnView: "install" | "tokens";
      readonly view: "token-editor";
    };

interface ConfirmationState {
  readonly confirmLabel: string;
  readonly description: string;
  readonly destructive?: boolean;
  readonly icon?: IconName;
  readonly onConfirm: () => Promise<void>;
  readonly title: string;
}

interface CredentialFormErrors {
  readonly label?: string;
  readonly token?: string;
}

interface ErrorAlertProps {
  readonly class?: string;
  readonly message: string;
}

function ErrorAlert(props: ErrorAlertProps): JSX.Element {
  return (
    <Alert
      class={`game-scripts-dialog__error-alert ${props.class ?? ""}`}
      variant="error"
    >
      <AlertDescription title={props.message}>
        <Icon
          aria-hidden="true"
          class="game-scripts-dialog__error-icon"
          icon="circle_alert"
          size="sm"
        />
        <span>{props.message}</span>
      </AlertDescription>
    </Alert>
  );
}

interface ScriptsConfirmationDialogProps {
  readonly busy: boolean;
  readonly error: string;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly pending: ConfirmationState | null;
}

function ScriptsConfirmationDialog(
  props: ScriptsConfirmationDialogProps,
): JSX.Element {
  let cancelButton: HTMLButtonElement | null = null;

  return (
    <AlertDialog
      initialFocusEl={() => cancelButton}
      open={props.pending !== null}
      onOpenChange={(details) => {
        if (!details.open) props.onClose();
      }}
    >
      <AlertDialogContent
        class="game-scripts-dialog__confirmation-dialog"
        showCloseButton={false}
      >
        <Show when={props.pending} keyed>
          {(pending) => (
            <section class="game-scripts-dialog__confirmation">
              <div>
                <AlertDialogHeader>
                  <AlertDialogTitle>{pending.title}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {pending.description}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Show when={props.error !== ""}>
                  <ErrorAlert
                    class="game-scripts-dialog__confirmation-alert"
                    message={props.error}
                  />
                </Show>
                <AlertDialogFooter
                  class="game-scripts-dialog__confirmation-actions"
                  variant="bare"
                >
                  <AlertDialogCancel
                    disabled={props.busy}
                    ref={(element) => {
                      cancelButton = element;
                    }}
                    variant="outline"
                  >
                    Cancel
                  </AlertDialogCancel>
                  <Button
                    loading={props.busy}
                    onClick={props.onConfirm}
                    variant={pending.destructive ? "destructive" : "default"}
                  >
                    {pending.confirmLabel}
                  </Button>
                </AlertDialogFooter>
              </div>
            </section>
          )}
        </Show>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface CatalogRefreshButtonProps {
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly onClick: () => void;
}

function CatalogRefreshButton(props: CatalogRefreshButtonProps): JSX.Element {
  return (
    <IconButton
      aria-label="Refresh catalog"
      class="game-scripts-dialog__refresh-button"
      disabled={props.disabled}
      loading={props.loading}
      onClick={props.onClick}
      size="icon"
      title="Refresh catalog"
      variant="outline"
    >
      <Icon icon="refresh_cw" size="sm" />
    </IconButton>
  );
}

interface PackageUpdateCheckButtonProps {
  readonly checking: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly title?: string | undefined;
  readonly variant: Extract<ButtonVariant, "ghost" | "secondary">;
}

function PackageUpdateCheckButton(
  props: PackageUpdateCheckButtonProps,
): JSX.Element {
  return (
    <Button
      aria-busy={props.checking ? "true" : undefined}
      disabled={props.disabled || props.checking}
      onClick={props.onClick}
      size="sm"
      title={props.title}
      variant={props.variant}
    >
      <Show when={props.checking}>
        <Spinner
          class="game-scripts-dialog__package-update-spinner"
          size="sm"
        />
      </Show>
      {props.label}
    </Button>
  );
}

export type ScriptOptionsSaveStatus = "failed" | "idle" | "saving";

export interface ScriptsDialogProps {
  readonly bridge?: DesktopScriptingBridge;
  readonly fixture?: ScriptsDialogFixture;
  readonly inputsAvailable: boolean;
  readonly loadedReference: ScriptReference | undefined;
  readonly onChooseFile: (replaceRunning: boolean) => Promise<void>;
  readonly onCommitRoomNumber: () => void;
  readonly onCopyText: (text: string) => Promise<void>;
  readonly onEditInputs: () => void;
  readonly onEnqueueScript: (reference: ScriptReference) => Promise<boolean>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectRoomPolicy: (
    policy: Exclude<RoomPolicy, { readonly kind: "specific" }>,
  ) => void;
  readonly onSelectScript: (
    reference: ScriptReference,
    start: boolean,
    replaceRunning: boolean,
  ) => Promise<void>;
  readonly onSetRoomNumberDraft: (value: string) => void;
  readonly onQueueClear: () => void;
  readonly onQueueEditInputs: (entryId: string) => Promise<boolean>;
  readonly onQueueMove: (entryId: string, offset: -1 | 1) => void;
  readonly onQueueRemove: (entryId: string) => void;
  readonly onQueueRunNext: () => void;
  readonly onQueueStart: () => Promise<boolean>;
  readonly onQueueStop: () => Promise<void>;
  readonly onRetryOptionsSave: () => void;
  readonly onToggleRestartAfterReconnect: () => void;
  readonly onToggleSafeStartStop: () => void;
  readonly onToggleScript: () => void | Promise<void>;
  readonly loggedIn: boolean;
  readonly open: boolean;
  readonly optionsReady: boolean;
  readonly optionsSaveStatus: ScriptOptionsSaveStatus;
  readonly queueState: ScriptQueueState;
  readonly restartAfterReconnect: boolean;
  readonly roomNumberDraft: string;
  readonly roomNumberError: string;
  readonly roomPolicy: RoomPolicy;
  readonly safeStartStop: boolean;
  readonly scriptBusy: boolean;
  readonly scriptLoaded: boolean;
  readonly scriptRunning: boolean;
  readonly scriptStatus: string;
}

/** Supplies catalog state directly when the dialog is rendered outside Electron. */
export interface ScriptsDialogFixture {
  readonly activeTab?: ScriptsDialogTab | undefined;
  readonly catalog: ScriptCatalogOverview;
  readonly catalogLoading?: boolean | undefined;
  readonly confirmation?:
    | {
        readonly confirmLabel: string;
        readonly description: string;
        readonly destructive?: boolean;
        readonly error: string;
        readonly title: string;
      }
    | undefined;
  readonly credentials?: readonly GitHubCredentialSummary[] | undefined;
  readonly error?: string | undefined;
  readonly errorRetryable?: boolean | undefined;
  readonly packageManagementView?: PackageManagementView | undefined;
  readonly scripts?: readonly ScriptCatalogEntry[] | undefined;
  readonly search?: string | undefined;
  readonly selectedPackagePath?: string | undefined;
}

const emptyCatalog = (): ScriptCatalogOverview => ({
  packages: [],
  revision: "",
  scriptCount: 0,
});

const errorMessage = (cause: unknown, fallback: string): string => {
  if (!(cause instanceof Error) || cause.message.trim() === "") return fallback;
  return cause.message.replace(/^Uncaught DesktopBridgeError:\s*/, "");
};

const sameReference = (
  left: ScriptReference | undefined,
  right: ScriptReference,
): boolean =>
  left?.kind === right.kind &&
  left.path === right.path &&
  (left.kind !== "package" ||
    (right.kind === "package" && left.packageName === right.packageName));

const scriptLocation = (entry: ScriptCatalogEntry): string =>
  entry.packageName === undefined
    ? entry.relativePath
    : `${entry.packageName}/${entry.relativePath}`;

const queueItemStatus = (item: ScriptQueueRunItem): string => {
  if (item.state === "active") return "Running";
  if (item.state === "pending") return "Pending";
  const result = item.result;
  if (result === undefined) return "Stopped";
  switch (result.kind) {
    case "completed":
      return "Completed";
    case "failed":
      return `Failed: ${result.status.message}`;
    case "script-exited":
      return "Exited";
    case "externally-stopped":
    case "script-stopped":
      return result.status.reason === undefined
        ? "Stopped"
        : `Stopped: ${result.status.reason}`;
  }
};

const queueItemDuration = (item: ScriptQueueRunItem): string | undefined => {
  if (item.durationMs === undefined) return undefined;
  if (item.durationMs < 1_000) return `${Math.round(item.durationMs)} ms`;
  return `${(item.durationMs / 1_000).toFixed(1)} s`;
};

const queueItemFinishedAt = (item: ScriptQueueRunItem): string | undefined => {
  const status = item.result?.status;
  if (status === undefined) return undefined;
  const timestamp =
    status.state === "completed"
      ? status.completedAt
      : status.state === "failed"
        ? status.failedAt
        : status.stoppedAt;
  return `Finished at ${new Date(timestamp).toLocaleString()}`;
};

const scriptContext = (entry: ScriptCatalogEntry): string | undefined => {
  const separatorIndex = entry.relativePath.lastIndexOf("/");
  const directory =
    separatorIndex === -1
      ? undefined
      : entry.relativePath.slice(0, separatorIndex);
  if (entry.packageName === undefined) return directory;
  return directory === undefined
    ? entry.packageName
    : `${entry.packageName}/${directory}`;
};

const packageCompatibilityDetail = (entry: ValidScriptPackage): string => {
  switch (entry.compatibility.status) {
    case "compatible":
      return `This package requires Lucent ${entry.compatibility.requiredVersion}. You're using v${entry.compatibility.currentVersion}, which is compatible.`;
    case "incompatible":
      return `This package requires Lucent ${entry.compatibility.requiredVersion}, but you're using v${entry.compatibility.currentVersion}. Its code can't be used.`;
    case "unknown":
      return "Lucent can't check compatibility because the package doesn't include a valid Lucent version requirement.";
  }
};

const packageDependencyIssueDetail = (
  issue: ScriptPackageDependencyIssue,
): string => {
  switch (issue.reason) {
    case "missing":
      return `${issue.packageName} is missing. Install it to use this package.`;
    case "version-mismatch": {
      const exact = /^(\d+)\.(\d+)\.(\d+)$/.exec(issue.requiredVersion);
      if (exact !== null) {
        return `${issue.packageName} version ${issue.requiredVersion} is required. Version ${issue.installedVersion} is installed.`;
      }
      const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(issue.requiredVersion);
      if (caret !== null) {
        const major = Number(caret[1]);
        const minor = Number(caret[2]);
        const patch = Number(caret[3]);
        const series =
          major > 0
            ? `${major}.x`
            : minor > 0
              ? `0.${minor}.x`
              : `0.0.${patch}`;
        return major === 0 && minor === 0
          ? `${issue.packageName} version ${series} is required. Version ${issue.installedVersion} is installed.`
          : `${issue.packageName} needs a compatible version. Install version ${major}.${minor}.${patch} or newer in the ${series} series.`;
      }
      return `${issue.packageName} version ${issue.installedVersion} isn't compatible. Update or replace it to use this package.`;
    }
    case "version-unavailable":
      return `Lucent can't check ${issue.packageName}'s version. Install a versioned release to use this package.`;
    case "unavailable":
      return `${issue.packageName} can't be used. Fix that package first.`;
  }
};

const packageDependencyDetail = (entry: ValidScriptPackage): string =>
  entry.dependencyStatus.status === "ready"
    ? ""
    : entry.dependencyStatus.issues.map(packageDependencyIssueDetail).join(" ");

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "always",
});

const formatRelativeTime = (value: string, now = Date.now()): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "at an unknown time";

  const difference = timestamp - now;
  const absoluteDifference = Math.abs(difference);
  if (absoluteDifference < 45_000) return "just now";

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (absoluteDifference < hour) {
    return relativeTimeFormatter.format(
      Math.round(difference / minute),
      "minute",
    );
  }
  if (absoluteDifference < day) {
    return relativeTimeFormatter.format(Math.round(difference / hour), "hour");
  }
  if (absoluteDifference < month) {
    return relativeTimeFormatter.format(
      Math.round(difference / (absoluteDifference < week ? day : week)),
      absoluteDifference < week ? "day" : "week",
    );
  }
  if (absoluteDifference < year) {
    return relativeTimeFormatter.format(
      Math.round(difference / month),
      "month",
    );
  }
  return relativeTimeFormatter.format(Math.round(difference / year), "year");
};

interface PackageCheckSummary {
  readonly timestampLabel?: string;
  readonly timestamp?: string;
}

const packageCheckSummary = (
  entry: ValidScriptPackage,
  now: number,
): PackageCheckSummary => {
  switch (entry.update.status) {
    case "available":
    case "current":
      return {
        timestamp: entry.update.checkedAt,
        timestampLabel: "Checked",
      };
    case "rate-limited": {
      const timing = scriptPackageRateLimitTiming(entry.update.retryAt, now);
      return timing.status === "invalid"
        ? {}
        : {
            timestamp: entry.update.retryAt,
            timestampLabel:
              timing.status === "active" ? "Retry" : "Cooldown ended",
          };
    }
    case "unknown":
      return entry.update.checkedAt === undefined
        ? {}
        : {
            timestamp: entry.update.checkedAt,
            timestampLabel: "Checked",
          };
    case "unchecked":
      return {};
  }
};

type PackagePrimaryAction = "check" | "open-folder" | "restore" | "update";

const packagePrimaryAction = (
  entry: ValidScriptPackage,
): PackagePrimaryAction | undefined => {
  if (entry.integrity === "unmanaged") return "open-folder";
  if (entry.source === undefined) return undefined;
  if (entry.integrity === "modified") {
    return entry.update.status === "available" ? "update" : "restore";
  }
  if (entry.update.status === "available") return "update";
  if (
    entry.update.status === "unchecked" ||
    entry.update.status === "unknown" ||
    entry.update.status === "rate-limited"
  ) {
    return "check";
  }
  return undefined;
};

const packagePrimaryActionLabels: Record<PackagePrimaryAction, string> = {
  check: "Check",
  "open-folder": "Open folder",
  restore: "Restore",
  update: "Update",
};

const packageFooterPrimaryAction = (
  entry: ValidScriptPackage,
): PackagePrimaryAction | undefined => {
  const action = packagePrimaryAction(entry);
  return action === "update" ? undefined : action;
};

const packageIntegrityDetail = (
  entry: ValidScriptPackage,
  integrity: "modified" | "unmanaged",
): string => {
  switch (integrity) {
    case "modified":
      return (
        "This package has local changes. Updating will overwrite them." +
        (entry.update.status === "available"
          ? " A newer version is also available."
          : "")
      );
    case "unmanaged":
      return "Lucent didn't install this folder, so it can't verify or update it.";
  }
};

const packageRateLimitTitle = (
  limit: ActiveScriptPackageRateLimit | undefined,
): string | undefined =>
  limit === undefined
    ? undefined
    : `GitHub's request limit has been reached. Try again after ${new Date(limit.retryAtTimestamp).toLocaleString()}.`;

interface PackageDisplayStatus {
  readonly description: string;
  readonly icon: IconName;
  readonly label: string;
  readonly listLabel: string;
  readonly tone: "error" | "info" | "secondary" | "success" | "warning";
}

const packageAlertVariant = (status: PackageDisplayStatus): AlertVariant =>
  status.tone === "secondary" ? "default" : status.tone;

const packageDisplayStatus = (
  entry: ValidScriptPackage,
  now = Date.now(),
): PackageDisplayStatus => {
  if (entry.compatibility.status === "incompatible") {
    return {
      description: packageCompatibilityDetail(entry),
      icon: "triangle_alert",
      label: "Incompatible",
      listLabel: "Needs attention",
      tone: "error",
    };
  }

  if (entry.dependencyStatus.status === "blocked") {
    return {
      description: packageDependencyDetail(entry),
      icon: "triangle_alert",
      label: "Dependencies unavailable",
      listLabel: "Needs attention",
      tone: "error",
    };
  }

  if (entry.integrity === "modified") {
    return {
      description: packageIntegrityDetail(entry, entry.integrity),
      icon: "triangle_alert",
      label:
        entry.update.status === "available"
          ? "Modified, update available"
          : "Modified",
      listLabel: "Needs attention",
      tone: "warning",
    };
  }

  if (entry.integrity === "unmanaged") {
    return {
      description: packageIntegrityDetail(entry, entry.integrity),
      icon: "help_circle",
      label: "Unmanaged",
      listLabel: "Needs attention",
      tone: "warning",
    };
  }

  if (entry.compatibility.status === "unknown") {
    return {
      description: packageCompatibilityDetail(entry),
      icon: "help_circle",
      label: "Compatibility unknown",
      listLabel: "Needs attention",
      tone: "warning",
    };
  }

  if (entry.warning !== undefined) {
    return {
      description: entry.warning,
      icon: "triangle_alert",
      label: "Package warning",
      listLabel: "Needs attention",
      tone: "warning",
    };
  }

  if (entry.source === undefined) {
    return {
      description:
        "This verified package has no remote source, so Lucent can't check it for updates.",
      icon: "check",
      label: "Local package",
      listLabel: "Local package",
      tone: "secondary",
    };
  }

  switch (entry.update.status) {
    case "available":
      return {
        description:
          entry.update.revision.kind === "commit"
            ? `The package's Git ref points to a newer commit (${entry.update.revision.sha.slice(0, 7)}).`
            : `The package directory has changed (${entry.update.revision.sha.slice(0, 7)}).`,
        icon: "download",
        label: "Update available",
        listLabel: "Update available",
        tone: "info",
      };
    case "current":
      return {
        description:
          entry.source.kind === "repository"
            ? "This package is compatible and unchanged. Its Git ref still points to the installed commit."
            : "This package is compatible and unchanged. Its package directory matches the installed tree.",
        icon: "check",
        label: "Up to date",
        listLabel: "Up to date",
        tone: "success",
      };
    case "rate-limited": {
      const timing = scriptPackageRateLimitTiming(entry.update.retryAt, now);
      if (timing.status !== "active") {
        return {
          description:
            timing.status === "elapsed"
              ? "GitHub's cooldown has ended. Check again to refresh the package status."
              : "GitHub saved an invalid retry deadline. Check again to refresh the package status.",
          icon: "git_compare_arrows",
          label: "Ready to check",
          listLabel: "Ready to check",
          tone: "info",
        };
      }
      return {
        description: `GitHub's request limit has been reached. Try again ${formatRelativeTime(entry.update.retryAt, now)}.`,
        icon: "triangle_alert",
        label: "Rate limited",
        listLabel: "Try later",
        tone: "warning",
      };
    }
    case "unknown":
      return {
        description: `${entry.update.message} No files were changed.`,
        icon: "triangle_alert",
        label: "Check failed",
        listLabel: "Needs attention",
        tone: "warning",
      };
    case "unchecked":
      return {
        description:
          "This package hasn't changed, but Lucent hasn't checked its Git ref for updates yet.",
        icon: "help_circle",
        label: "Updates not checked",
        listLabel: "Not checked",
        tone: "secondary",
      };
  }
};

const packageNoticeDescription = (
  entry: ValidScriptPackage,
  displayStatus: PackageDisplayStatus,
): string => {
  const details = [displayStatus.description];

  // The badge shows the most urgent status, but the notice retains every
  // problem the user needs to address.
  if (entry.compatibility.status === "incompatible") {
    if (entry.dependencyStatus.status === "blocked") {
      details.push(packageDependencyDetail(entry));
    }
    if (entry.integrity !== "verified") {
      details.push(packageIntegrityDetail(entry, entry.integrity));
    }
  } else if (entry.dependencyStatus.status === "blocked") {
    if (entry.integrity !== "verified") {
      details.push(packageIntegrityDetail(entry, entry.integrity));
    }
  } else if (
    entry.compatibility.status === "unknown" &&
    entry.integrity !== "verified"
  ) {
    details.push(packageCompatibilityDetail(entry));
  }

  return details.join(" ");
};

const needsPackageNotice = (entry: ValidScriptPackage): boolean =>
  entry.compatibility.status === "incompatible" ||
  entry.dependencyStatus.status === "blocked" ||
  entry.integrity === "modified" ||
  entry.integrity === "unmanaged" ||
  entry.compatibility.status === "unknown" ||
  entry.warning !== undefined ||
  entry.update.status === "available" ||
  entry.update.status === "unknown" ||
  entry.update.status === "rate-limited";

export function ScriptsDialog(props: ScriptsDialogProps): JSX.Element {
  const fixtureMode = props.fixture !== undefined;
  const initialPackageManagementView =
    props.fixture?.packageManagementView ?? "installed";
  let queueList: ScriptQueueListApi | undefined;
  const queueRunItems = createMemo(
    () =>
      new Map(
        props.queueState.latestRun?.items.map((item) => [item.entryId, item]),
      ),
  );
  const [scriptViewport, setScriptViewport] = createSignal<HTMLDivElement>();
  const [scriptViewportWidth, setScriptViewportWidth] = createSignal(0);
  const scriptContextLimit = createMemo(() =>
    scriptContextCharacterLimit(scriptViewportWidth()),
  );
  const [packageViewport, setPackageViewport] = createSignal<HTMLElement>();
  const [catalog, setCatalog] = createSignal<ScriptCatalogOverview>(
    props.fixture?.catalog ?? emptyCatalog(),
  );
  const [catalogLoading, setCatalogLoading] = createSignal(
    props.fixture?.catalogLoading ?? !fixtureMode,
  );
  const [catalogSyncing, setCatalogSyncing] = createSignal(false);
  const [pendingCatalogRevision, setPendingCatalogRevision] = createSignal<
    string | null
  >(null);
  const [credentials, setCredentials] = createSignal<
    readonly GitHubCredentialSummary[]
  >(props.fixture?.credentials ?? []);
  const [activeTab, setActiveTab] = createSignal<ScriptsDialogTab>(
    props.fixture?.activeTab ?? "scripts",
  );
  const [search, setSearch] = createSignal(props.fixture?.search ?? "");
  const [catalogQuery, setCatalogQuery] = createSignal(
    props.fixture?.search?.trim() ?? "",
  );
  const [scriptPages, setScriptPages] = createSignal<ScriptCatalogPageCache>(
    props.fixture?.scripts === undefined
      ? new Map()
      : new Map([[0, props.fixture.scripts]]),
  );
  const [scriptQueryLoading, setScriptQueryLoading] = createSignal(false);
  const [scriptQueryIndicatorVisible, setScriptQueryIndicatorVisible] =
    createSignal(false);
  const [scriptTotal, setScriptTotal] = createSignal(
    props.fixture?.scripts?.length ?? 0,
  );
  const [enqueueingReference, setEnqueueingReference] =
    createSignal<ScriptReference>();
  const [recentlyQueuedReference, setRecentlyQueuedReference] =
    createSignal<ScriptReference>();
  const [queueAnnouncement, setQueueAnnouncement] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [checkingPackageUpdates, setCheckingPackageUpdates] =
    createSignal(false);
  const [checkingPackageName, setCheckingPackageName] = createSignal<string>();
  const [error, setErrorText] = createSignal(
    props.fixture?.confirmation?.error ?? props.fixture?.error ?? "",
  );
  const [errorRetryable, setErrorRetryable] = createSignal(
    props.fixture?.errorRetryable ?? false,
  );
  const setError = (message: string): void => {
    setErrorRetryable(false);
    setErrorText(message);
  };
  const setRetryableError = (message: string): void => {
    setErrorRetryable(true);
    setErrorText(message);
  };
  const clearRetryableError = (): void => {
    if (!errorRetryable()) return;
    setErrorRetryable(false);
    setErrorText("");
  };
  const [packageManagementView, setPackageManagementView] =
    createSignal<PackageCollectionView>(
      initialPackageManagementView === "details" ? "details" : "installed",
    );
  const [packageTask, setPackageTask] = createSignal<PackageTaskState>(
    initialPackageManagementView === "install"
      ? { view: "install" }
      : initialPackageManagementView === "credentials"
        ? { view: "tokens" }
        : { view: "closed" },
  );
  const [selectedPackagePath, setSelectedPackagePath] = createSignal<
    string | undefined
  >(props.fixture?.selectedPackagePath);
  const [installOptionsOpen, setInstallOptionsOpen] = createSignal(false);
  const [roomEditingMode, setRoomEditingMode] =
    createSignal<RoomPolicyMode | null>(null);
  const initialConfirmation = props.fixture?.confirmation;
  const [confirmation, setConfirmation] =
    createSignal<ConfirmationState | null>(
      initialConfirmation === undefined
        ? null
        : {
            confirmLabel: initialConfirmation.confirmLabel,
            description: initialConfirmation.description,
            ...(initialConfirmation.destructive === undefined
              ? {}
              : { destructive: initialConfirmation.destructive }),
            onConfirm: () => Promise.resolve(),
            title: initialConfirmation.title,
          },
    );
  const [repositoryUrl, setRepositoryUrl] = createSignal("");
  const [repositoryValidationAttempted, setRepositoryValidationAttempted] =
    createSignal(false);
  const [packageDirectory, setPackageDirectory] = createSignal("");
  const [packageDirectoryInvalid, setPackageDirectoryInvalid] =
    createSignal(false);
  const [repositoryRef, setRepositoryRef] = createSignal("");
  const [credentialId, setCredentialId] = createSignal("");
  const [editingCredentialId, setEditingCredentialId] = createSignal("");
  const [credentialLabel, setCredentialLabel] = createSignal("");
  const [credentialToken, setCredentialToken] = createSignal("");
  const [credentialFormErrors, setCredentialFormErrors] =
    createSignal<CredentialFormErrors>({});
  const [credentialTokenVisible, setCredentialTokenVisible] =
    createSignal(false);
  const [copiedRevisionPath, setCopiedRevisionPath] = createSignal<string>();
  const [rateLimitNow, setRateLimitNow] = createSignal(Date.now());
  const [leftoverCopies, setLeftoverCopies] = createSignal<
    readonly ScriptPackageLeftoverCopy[]
  >([]);
  const [leftoverError, setLeftoverError] = createSignal("");
  let leftoverRequestId = 0;
  let catalogRequestId = 0;
  let scriptQueryRequestId = 0;
  let requestedCatalogQuery = "";
  let scriptPageGeneration = 0;
  const scriptPageRequests = new Set<string>();
  let searchTimer: number | undefined;
  let queueAddedFeedbackTimer: number | undefined;
  let queueAnnouncementFrame: number | undefined;
  let copiedRevisionTimer: number | undefined;
  let packageInstallButton: HTMLButtonElement | undefined;
  let packageTaskTitle: HTMLHeadingElement | undefined;
  let repositoryInputElement: HTMLInputElement | undefined;
  let packageDirectoryInput: HTMLInputElement | undefined;
  let credentialLabelInput: HTMLInputElement | undefined;
  let credentialTokenInput: HTMLInputElement | undefined;
  let manageTokensAddButton: HTMLButtonElement | undefined;
  let scriptViewportResizeObserver: ResizeObserver | undefined;
  const scrollPositions: Record<ScrollableScriptsDialogTab, number> = {
    packages: 0,
    scripts: 0,
  };

  const replaceCatalog = (nextCatalog: ScriptCatalogOverview): void => {
    setRateLimitNow(Date.now());
    const revisionChanged = catalog().revision !== nextCatalog.revision;
    setCatalog(nextCatalog);
    if (revisionChanged) {
      scriptQueryRequestId += 1;
      requestedCatalogQuery = catalogQuery();
      setScriptQueryLoading(false);
      scriptPageGeneration += 1;
      scriptPageRequests.clear();
      setScriptPages(new Map());
      setScriptTotal(catalogQuery() === "" ? nextCatalog.scriptCount : 0);
      const nextQuery = search().trim();
      if (nextQuery !== catalogQuery()) {
        void requestScriptQuery(nextQuery);
      } else if (catalogQuery() !== "") {
        void requestScriptPages([0]);
      }
    }
  };

  const selectedCredential = createMemo(() =>
    credentials().find((entry) => entry.id === credentialId()),
  );

  const selectedPackage = createMemo(() =>
    catalog().packages.find((entry) => entry.path === selectedPackagePath()),
  );

  const packageTaskOpen = createMemo(() => packageTask().view !== "closed");

  const queueEntryCount = createMemo(() => props.queueState.entries.length);

  const queueBadgeText = createMemo(() => {
    const count = queueEntryCount();
    return count > QUEUE_BADGE_MAX_COUNT
      ? `${QUEUE_BADGE_MAX_COUNT}+`
      : String(count);
  });

  const queueTabLabel = createMemo(() => {
    const count = queueEntryCount();
    if (count === 0) return "Queue";
    return `Queue, ${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
  });

  const packageTaskTitleText = createMemo(() => {
    const task = packageTask();
    switch (task.view) {
      case "closed":
        return "";
      case "install":
        return "Install package";
      case "tokens":
        return "GitHub tokens";
      case "token-editor":
        return editingCredentialId() === ""
          ? "Add GitHub token"
          : "Replace token";
    }
  });

  const packageTaskDescription = createMemo(() => {
    const task = packageTask();
    switch (task.view) {
      case "closed":
        return "";
      case "install":
        return "Install a package from a GitHub repository you trust. It can contain scripts, reusable library code, or both.";
      case "tokens":
        return "Manage personal access tokens used to install and update GitHub packages.";
      case "token-editor":
        return editingCredentialId() === ""
          ? GITHUB_TOKEN_USE_HINT
          : `Enter a new token for ${credentialLabel()}.`;
    }
  });

  const packageTaskInitialFocusElement = (): HTMLElement | null => {
    const task = packageTask();
    switch (task.view) {
      case "closed":
        return null;
      case "install":
        return repositoryInputElement ?? null;
      case "tokens":
        return manageTokensAddButton ?? null;
      case "token-editor":
        return editingCredentialId() === ""
          ? (credentialLabelInput ?? null)
          : (credentialTokenInput ?? null);
    }
  };

  let previousPackageTaskView: PackageTaskState["view"] = packageTask().view;
  createEffect(() => {
    const nextView = packageTask().view;
    const previousView = previousPackageTaskView;
    previousPackageTaskView = nextView;
    if (
      previousView === "closed" ||
      nextView === "closed" ||
      previousView === nextView
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      packageTaskTitle?.focus({ preventScroll: true });
    });
    onCleanup(() => window.cancelAnimationFrame(frame));
  });

  const repositoryInput = createMemo(() =>
    parseGitHubRepositoryInput(repositoryUrl()),
  );
  const repositorySuggestion = createMemo(() => {
    const input = repositoryInput();
    return input.kind === "tree" ? input : undefined;
  });
  const repositoryFieldInvalid = createMemo(() => {
    const input = repositoryInput();
    return (
      (input.kind === "invalid" && repositoryUrl().trim() !== "") ||
      (repositoryValidationAttempted() && input.kind !== "repository")
    );
  });

  const applyRepositorySuggestion = (): void => {
    const input = repositoryInput();
    if (input.kind !== "tree") return;
    setRepositoryUrl(input.repository.url);
    setRepositoryRef(input.ref);
    setRepositoryValidationAttempted(false);
    setInstallOptionsOpen(true);
    setError("");
  };

  const activePackageRateLimits = createMemo(() =>
    activeScriptPackageRateLimits(catalog().packages, rateLimitNow()),
  );

  const packageActiveRateLimit = (
    entry: ValidScriptPackage,
  ): ActiveScriptPackageRateLimit | undefined =>
    scriptPackageRateLimit(entry, activePackageRateLimits());

  const packagesEligibleForUpdateCheck = createMemo(() =>
    scriptPackagesEligibleForUpdateCheck(
      catalog().packages,
      activePackageRateLimits(),
    ),
  );

  const hasManagedPackages = createMemo(() =>
    catalog().packages.some(
      (entry) => entry.status === "valid" && entry.source !== undefined,
    ),
  );

  const installRateLimit = createMemo(() =>
    activePackageRateLimits().get(
      scriptPackageCredentialRateLimitScope(
        credentialId() === "" ? undefined : credentialId(),
      ),
    ),
  );

  const packageActionLabel = (
    entry: ValidScriptPackage,
    action: PackagePrimaryAction,
  ): string => {
    const activeLimit = packageActiveRateLimit(entry);
    if (activeLimit !== undefined) {
      return formatScriptPackageRetryLabel(
        activeLimit.retryAtTimestamp,
        rateLimitNow(),
      );
    }
    if (action === "check" && entry.update.status === "rate-limited") {
      return "Check again";
    }
    return packagePrimaryActionLabels[action];
  };

  const packageUpdateCheckLabel = (entry: ValidScriptPackage): string => {
    const activeLimit = packageActiveRateLimit(entry);
    return activeLimit === undefined
      ? "Check for updates"
      : formatScriptPackageRetryLabel(
          activeLimit.retryAtTimestamp,
          rateLimitNow(),
        );
  };

  createEffect(() => {
    if (
      packageManagementView() === "details" &&
      selectedPackage() === undefined
    ) {
      setSelectedPackagePath(undefined);
      setPackageManagementView("installed");
    }
  });

  createEffect(() => {
    if (props.open) setRateLimitNow(Date.now());
  });

  createEffect(() => {
    if (!props.open) return;
    const now = rateLimitNow();
    const retryTimestamps = [...activePackageRateLimits().values()].map(
      (limit) => limit.retryAtTimestamp,
    );
    if (retryTimestamps.length === 0) return;

    const nextRetryAt = Math.min(...retryTimestamps);
    const wakeAt = Math.min(nextRetryAt, now + 60_000);
    const timer = window.setTimeout(
      () => setRateLimitNow(Date.now()),
      Math.max(25, wakeAt - Date.now() + 25),
    );
    onCleanup(() => window.clearTimeout(timer));
  });

  const requestScriptPages = async (
    offsets: readonly number[],
  ): Promise<void> => {
    const bridge = props.bridge;
    if (bridge === undefined || fixtureMode) return;
    const revision = catalog().revision;
    if (revision === "") return;
    const generation = scriptPageGeneration;
    const query = catalogQuery();
    const currentPages = scriptPages();
    const requestedOffsets = offsets.filter(
      (offset) =>
        !currentPages.has(offset) &&
        !scriptPageRequests.has(`${generation}:${offset}`),
    );
    const firstOffset = requestedOffsets[0];
    const lastOffset = requestedOffsets.at(-1);
    if (firstOffset === undefined || lastOffset === undefined) return;

    for (const offset of requestedOffsets) {
      scriptPageRequests.add(`${generation}:${offset}`);
    }
    try {
      const page = await bridge.getCatalogPage({
        limit: lastOffset - firstOffset + SCRIPT_CATALOG_PAGE_SIZE,
        offset: firstOffset,
        query,
        revision,
      });
      if (
        generation !== scriptPageGeneration ||
        query !== catalogQuery() ||
        revision !== catalog().revision
      ) {
        return;
      }
      if (page.revision !== revision) {
        setPendingCatalogRevision(page.revision);
        return;
      }
      setScriptTotal(page.total);
      setScriptPages((current) =>
        storeScriptCatalogPageRange(
          current,
          page.offset,
          page.entries,
          requestedOffsets,
        ),
      );
    } catch (cause) {
      if (generation === scriptPageGeneration && props.open) {
        setCatalogError("Failed to load script catalog rows.", cause);
      }
    } finally {
      for (const offset of requestedOffsets) {
        scriptPageRequests.delete(`${generation}:${offset}`);
      }
    }
  };

  const requestScriptQuery = async (query: string): Promise<void> => {
    requestedCatalogQuery = query;
    const requestId = ++scriptQueryRequestId;
    if (query === catalogQuery()) {
      setScriptQueryLoading(false);
      return;
    }

    const bridge = props.bridge;
    if (bridge === undefined || fixtureMode) {
      setScriptQueryLoading(false);
      return;
    }
    const revision = catalog().revision;
    if (revision === "" || !props.open) {
      setScriptQueryLoading(false);
      return;
    }

    setScriptQueryLoading(true);
    try {
      const page = await bridge.getCatalogPage({
        limit: SCRIPT_CATALOG_PAGE_SIZE,
        offset: 0,
        query,
        revision,
      });
      if (
        requestId !== scriptQueryRequestId ||
        query !== requestedCatalogQuery ||
        revision !== catalog().revision ||
        !props.open
      ) {
        return;
      }
      if (page.revision !== revision) {
        setScriptQueryLoading(false);
        setPendingCatalogRevision(page.revision);
        return;
      }

      scriptPageGeneration += 1;
      scriptPageRequests.clear();
      batch(() => {
        setCatalogQuery(query);
        setScriptTotal(page.total);
        setScriptPages(
          storeScriptCatalogPageRange(
            new Map(),
            page.offset,
            page.entries,
            [0],
          ),
        );
        setScriptQueryLoading(false);
      });
      scriptVirtualizer.scrollToOffset(0);
      scriptVirtualizer.measure();
      clearRetryableError();
    } catch (cause) {
      if (
        requestId === scriptQueryRequestId &&
        query === requestedCatalogQuery &&
        props.open
      ) {
        setScriptQueryLoading(false);
        setCatalogError("Failed to search the script catalog.", cause);
      }
    }
  };

  const requestScriptRange = (startIndex: number, endIndex: number): void => {
    const offsets = scriptCatalogPageOffsetsForRange({
      endIndex,
      startIndex,
      total: scriptTotal(),
    });
    if (offsets.length === 0) return;
    const currentPages = scriptPages();
    setScriptPages(touchScriptCatalogPages(currentPages, offsets));
    const generation = scriptPageGeneration;
    const missingOffsets = offsets.filter(
      (offset) =>
        !currentPages.has(offset) &&
        !scriptPageRequests.has(`${generation}:${offset}`),
    );
    for (const group of groupScriptCatalogPageOffsets(missingOffsets)) {
      void requestScriptPages(group);
    }
  };

  const requestScriptViewport = (viewport: HTMLDivElement): void => {
    const startIndex = Math.floor(viewport.scrollTop / SCRIPT_ROW_HEIGHT);
    const endIndex = Math.max(
      startIndex,
      Math.ceil(
        (viewport.scrollTop + viewport.clientHeight) / SCRIPT_ROW_HEIGHT,
      ) - 1,
    );
    requestScriptRange(startIndex, endIndex);
  };

  const scriptVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    estimateSize: () => SCRIPT_ROW_HEIGHT,
    get count() {
      return scriptTotal();
    },
    getItemKey: (index) => `${catalog().revision}:${catalogQuery()}:${index}`,
    getScrollElement: () => scriptViewport() ?? null,
    onChange: (instance) => {
      const items = instance.getVirtualItems();
      const first = items[0];
      const last = items.at(-1);
      if (first !== undefined && last !== undefined) {
        untrack(() => requestScriptRange(first.index, last.index));
      }
    },
    overscan: 10,
  });

  const restoreScrollPosition = (
    tab: ScrollableScriptsDialogTab,
    viewport: HTMLElement,
  ): void => {
    requestAnimationFrame(() => {
      if (activeTab() !== tab || !viewport.isConnected) return;
      viewport.scrollTop = scrollPositions[tab];
    });
  };

  const mountScriptViewport = (element: HTMLDivElement): void => {
    setScriptViewport(element);
    setScriptViewportWidth(element.clientWidth);
    restoreScrollPosition("scripts", element);
  };

  const mountPackageViewport = (element: HTMLElement): void => {
    setPackageViewport(element);
    restoreScrollPosition("packages", element);
  };

  const changeActiveTab = (value: string): void => {
    const current = activeTab();
    if (current === "scripts") {
      const viewport = scriptViewport();
      if (viewport !== undefined) {
        scrollPositions.scripts = viewport.scrollTop;
      }
    } else if (current === "packages") {
      const viewport = packageViewport();
      if (viewport !== undefined) {
        scrollPositions.packages = viewport.scrollTop;
      }
    }

    const next: ScriptsDialogTab =
      value === "options" || value === "packages" || value === "queue"
        ? value
        : "scripts";
    setActiveTab(next);
    if (next === "scripts") {
      const viewport = scriptViewport();
      if (viewport !== undefined) restoreScrollPosition(next, viewport);
    } else if (next === "packages") {
      const viewport = packageViewport();
      if (viewport !== undefined) restoreScrollPosition(next, viewport);
    }
  };

  const roomMode = (): RoomPolicyMode =>
    roomEditingMode() ?? props.roomPolicy.kind;

  const roomMessage = createMemo(() => {
    if (props.roomNumberError !== "") return props.roomNumberError;
    if (props.roomNumberDraft.trim() === "") return "";
    const parsed = parseRoomNumberInput(props.roomNumberDraft);
    return parsed.status === "invalid"
      ? "Enter a room number from 1 to 99,999."
      : "";
  });

  const roomKind = createMemo(() => {
    const parsed = parseRoomNumberInput(props.roomNumberDraft);
    return parsed.status === "valid" ? roomNumberKind(parsed.value) : undefined;
  });

  const setOperationError = (fallback: string, cause: unknown): void => {
    console.error(`[game:scripts] ${fallback}`, cause);
    setError(errorMessage(cause, fallback));
  };

  const setCatalogError = (fallback: string, cause: unknown): void => {
    console.error(`[game:scripts] ${fallback}`, cause);
    setRetryableError(errorMessage(cause, fallback));
  };

  const copyRevision = async (
    packagePath: string,
    revision: string,
  ): Promise<void> => {
    try {
      await props.onCopyText(revision);
      if (copiedRevisionTimer !== undefined) {
        window.clearTimeout(copiedRevisionTimer);
      }
      setCopiedRevisionPath(packagePath);
      copiedRevisionTimer = window.setTimeout(() => {
        setCopiedRevisionPath(undefined);
        copiedRevisionTimer = undefined;
      }, 900);
    } catch (cause) {
      setOperationError("Failed to copy the revision hash.", cause);
    }
  };

  const loadCatalog = async (refresh: boolean): Promise<void> => {
    const bridge = props.bridge;
    if (bridge === undefined || fixtureMode) {
      setCatalogLoading(false);
      return;
    }
    const requestId = ++catalogRequestId;
    setCatalogLoading(true);
    try {
      const nextCatalog = await (refresh
        ? bridge.refreshCatalog()
        : bridge.getCatalog());
      if (requestId === catalogRequestId && props.open) {
        replaceCatalog(nextCatalog);
        clearRetryableError();
      }
    } catch (cause) {
      if (requestId === catalogRequestId && props.open) {
        setCatalogError("Failed to load the script catalog.", cause);
      }
    } finally {
      if (requestId === catalogRequestId) setCatalogLoading(false);
    }
  };

  const refreshLeftovers = async (): Promise<void> => {
    const bridge = props.bridge;
    if (bridge === undefined || fixtureMode) return;
    const requestId = ++leftoverRequestId;
    await refreshScriptPackageLeftovers({
      list: () => bridge.listPackageLeftovers(),
      isCurrent: () => requestId === leftoverRequestId && props.open,
      setCopies: setLeftoverCopies,
      setError: setLeftoverError,
    });
  };

  const refreshCatalog = async (): Promise<void> => {
    await Promise.all([loadCatalog(true), refreshLeftovers()]);
  };

  const refreshCredentials = async (): Promise<void> => {
    const bridge = props.bridge;
    if (bridge === undefined || fixtureMode) return;
    try {
      setCredentials(await bridge.listCredentials());
    } catch (cause) {
      setOperationError("Unable to load GitHub tokens. Try again.", cause);
    }
  };

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) void refreshLeftovers();
      },
    ),
  );

  createEffect(() => {
    const revision = untrack(() => catalog().revision);
    if (fixtureMode) {
      setCatalogLoading(props.fixture?.catalogLoading ?? false);
      return;
    }
    if (!props.open) {
      leftoverRequestId += 1;
      catalogRequestId += 1;
      scriptQueryRequestId += 1;
      requestedCatalogQuery = catalogQuery();
      scriptPageGeneration += 1;
      scriptPageRequests.clear();
      setScriptQueryLoading(false);
      setCatalogLoading(revision === "");
      return;
    }
    setError("");
    if (revision === "") {
      void Promise.all([loadCatalog(false), refreshCredentials()]);
    } else {
      setCatalogLoading(false);
      void refreshCredentials();
      const nextQuery = untrack(() => search().trim());
      if (nextQuery !== catalogQuery()) {
        void requestScriptQuery(nextQuery);
        return;
      }
      window.requestAnimationFrame(() => {
        if (!props.open) return;
        scriptVirtualizer.measure();
        const items = scriptVirtualizer.getVirtualItems();
        const first = items[0];
        const last = items.at(-1);
        if (first !== undefined && last !== undefined) {
          requestScriptRange(first.index, last.index);
        } else if (catalogQuery() !== "") {
          void requestScriptPages([0]);
        }
      });
    }
  });

  createEffect(() => {
    if (!scriptQueryLoading()) {
      setScriptQueryIndicatorVisible(false);
      return;
    }
    const timer = window.setTimeout(
      () => setScriptQueryIndicatorVisible(true),
      150,
    );
    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(() => {
    const revision = pendingCatalogRevision();
    const bridge = props.bridge;
    if (
      bridge === undefined ||
      fixtureMode ||
      revision === null ||
      !props.open ||
      busy() ||
      catalogLoading() ||
      catalogSyncing()
    ) {
      return;
    }
    if (catalog().revision === revision) {
      setPendingCatalogRevision(null);
      return;
    }

    setCatalogSyncing(true);
    void bridge
      .getCatalog()
      .then((nextCatalog) => {
        if (props.open) replaceCatalog(nextCatalog);
      })
      .catch((cause) => {
        setPendingCatalogRevision(null);
        if (props.open) {
          setOperationError("Failed to synchronize the script catalog.", cause);
        }
      })
      .finally(() => setCatalogSyncing(false));
  });

  onMount(() => {
    scriptViewportResizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setScriptViewportWidth(Math.round(entry.contentRect.width));
      }
    });

    const unsubscribe = props.bridge?.onCatalogChanged((change) => {
      if (change.revision !== catalog().revision) {
        setPendingCatalogRevision(change.revision);
      }
    });
    onCleanup(() => {
      scriptViewportResizeObserver?.disconnect();
      unsubscribe?.();
    });
  });

  createEffect(() => {
    const viewport = scriptViewport();
    const observer = scriptViewportResizeObserver;
    if (!props.open || viewport === undefined || observer === undefined) return;

    observer.observe(viewport);
    onCleanup(() => observer.unobserve(viewport));
  });

  createEffect(() => {
    const entryId = props.queueState.attentionEntryId;
    if (!props.open || entryId === undefined) return;
    untrack(() => changeActiveTab("queue"));
    const frame = requestAnimationFrame(() => {
      const index = props.queueState.entries.findIndex(
        (entry) => entry.id === entryId,
      );
      if (index !== -1) queueList?.focusIndex(index);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  onCleanup(() => {
    if (searchTimer !== undefined) {
      window.clearTimeout(searchTimer);
    }
    if (queueAddedFeedbackTimer !== undefined) {
      window.clearTimeout(queueAddedFeedbackTimer);
    }
    if (queueAnnouncementFrame !== undefined) {
      window.cancelAnimationFrame(queueAnnouncementFrame);
    }
    if (copiedRevisionTimer !== undefined) {
      window.clearTimeout(copiedRevisionTimer);
    }
  });

  const closeConfirmation = (): void => {
    if (busy()) return;
    setConfirmation(null);
    setError("");
  };

  const askForConfirmation = (value: ConfirmationState): void => {
    setError("");
    setConfirmation(() => value);
  };

  const runConfirmation = async (): Promise<void> => {
    const pending = confirmation();
    if (pending === null || busy()) return;
    setBusy(true);
    setError("");
    try {
      await pending.onConfirm();
    } catch (cause) {
      setOperationError("The operation failed.", cause);
    } finally {
      setBusy(false);
    }
  };

  const runScriptSelection = async (
    entry: ScriptCatalogEntry,
    start: boolean,
    replaceRunning: boolean,
  ): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      if (start) props.onOpenChange(false);
      await props.onSelectScript(entry.reference, start, replaceRunning);
      setConfirmation(null);
    } catch (cause) {
      if (start) props.onOpenChange(true);
      setOperationError(
        `Failed to ${start ? "start" : "load"} ${entry.name}.`,
        cause,
      );
    } finally {
      setBusy(false);
    }
  };

  const selectScript = (entry: ScriptCatalogEntry, start: boolean): void => {
    if (busy() || props.scriptBusy) return;
    const selected = sameReference(props.loadedReference, entry.reference);
    if (
      props.scriptRunning &&
      (!selected || props.queueState.phase !== "idle")
    ) {
      askForConfirmation({
        confirmLabel: start ? "Stop and start" : "Stop and load",
        description: `${displayScriptSourceText(props.scriptStatus)}. Stop it and ${start ? "start" : "load"} ${entry.name}?`,
        onConfirm: () => runScriptSelection(entry, start, true),
        title: "Replace the running script?",
      });
      return;
    }
    void runScriptSelection(entry, start, false);
  };

  const enqueueScript = async (entry: ScriptCatalogEntry): Promise<void> => {
    if (busy() || props.scriptBusy || props.queueState.phase !== "idle") return;
    if (queueAddedFeedbackTimer !== undefined) {
      window.clearTimeout(queueAddedFeedbackTimer);
      queueAddedFeedbackTimer = undefined;
    }
    if (queueAnnouncementFrame !== undefined) {
      window.cancelAnimationFrame(queueAnnouncementFrame);
      queueAnnouncementFrame = undefined;
    }
    setRecentlyQueuedReference(undefined);
    setQueueAnnouncement("");
    setEnqueueingReference(entry.reference);
    setBusy(true);
    setError("");
    try {
      const added = await props.onEnqueueScript(entry.reference);
      if (!added) return;

      setRecentlyQueuedReference(entry.reference);
      queueAddedFeedbackTimer = window.setTimeout(() => {
        setRecentlyQueuedReference(undefined);
        queueAddedFeedbackTimer = undefined;
      }, QUEUE_ADDED_FEEDBACK_DURATION_MS);
      queueAnnouncementFrame = window.requestAnimationFrame(() => {
        setQueueAnnouncement(`${scriptLocation(entry)} added to the queue.`);
        queueAnnouncementFrame = undefined;
      });
    } catch (cause) {
      setOperationError(`Failed to add ${entry.name} to the queue.`, cause);
    } finally {
      setEnqueueingReference(undefined);
      setBusy(false);
    }
  };

  const clearScriptSearch = (): void => {
    if (searchTimer !== undefined) {
      window.clearTimeout(searchTimer);
      searchTimer = undefined;
    }
    setSearch("");
    void requestScriptQuery("");
  };

  const updateScriptSearch = (value: string): void => {
    setSearch(value);
    if (searchTimer !== undefined) {
      window.clearTimeout(searchTimer);
    }
    scriptQueryRequestId += 1;
    requestedCatalogQuery = catalogQuery();
    setScriptQueryLoading(false);
    searchTimer = window.setTimeout(() => {
      void requestScriptQuery(value.trim());
      searchTimer = undefined;
    }, 100);
  };

  const chooseFile = (): void => {
    if (busy() || props.scriptBusy) return;
    if (props.scriptRunning) {
      askForConfirmation({
        confirmLabel: "Choose replacement",
        description:
          "Choose a replacement file. The current script will keep running until the new file loads successfully.",
        onConfirm: async () => {
          await props.onChooseFile(true);
          setConfirmation(null);
        },
        title: "Replace the running script?",
      });
      return;
    }
    setBusy(true);
    void props
      .onChooseFile(false)
      .catch((cause) => setOperationError("Failed to choose a script.", cause))
      .finally(() => setBusy(false));
  };

  const applyMutation = (result: ScriptPackageMutationResult): void => {
    setConfirmation(null);
    if (result.status === "completed" || result.status === "unchanged") {
      replaceCatalog(result.catalog);
    }
  };

  const applyInstallMutation = (result: ScriptPackageMutationResult): void => {
    applyMutation(result);
    if (result.status !== "completed" && result.status !== "unchanged") return;
    setRepositoryUrl("");
    setRepositoryValidationAttempted(false);
    setPackageDirectory("");
    setPackageDirectoryInvalid(false);
    setRepositoryRef("");
    setInstallOptionsOpen(false);
    setPackageTask({ view: "closed" });
    setPackageManagementView("installed");
  };

  const installPackage = async (
    request: ScriptPackageInstallRequest,
  ): Promise<void> => {
    const bridge = props.bridge;
    if (bridge === undefined) return;
    const result = await bridge.installPackage(request);
    if (result.status === "confirmation-required") {
      askForConfirmation({
        confirmLabel: "Replace package",
        description: `A package folder named ${result.packageName} already exists. Replace everything in it with the selected Git ref?`,
        destructive: true,
        onConfirm: async () => {
          applyInstallMutation(
            await bridge.installPackage({ ...request, replaceExisting: true }),
          );
        },
        title: "Replace the existing package?",
      });
      return;
    }
    applyInstallMutation(result);
  };

  const beginInstall = async (): Promise<void> => {
    if (busy() || installRateLimit() !== undefined) return;
    setRepositoryValidationAttempted(true);
    setError("");
    const input = repositoryInput();
    if (repositoryUrl().trim() === "") {
      window.requestAnimationFrame(() => repositoryInputElement?.focus());
      return;
    }
    if (input.kind === "tree") {
      window.requestAnimationFrame(() => repositoryInputElement?.focus());
      return;
    }
    if (input.kind === "invalid") {
      window.requestAnimationFrame(() => repositoryInputElement?.focus());
      return;
    }
    const subdirectory = packageDirectory().trim();
    if (
      subdirectory !== "" &&
      !isScriptPackageRepositorySubdirectory(subdirectory)
    ) {
      setPackageDirectoryInvalid(true);
      setInstallOptionsOpen(true);
      setError("");
      window.requestAnimationFrame(() => packageDirectoryInput?.focus());
      return;
    }
    const request: ScriptPackageInstallRequest = {
      repositoryUrl: input.repository.url,
      ...(repositoryRef().trim() === "" ? {} : { ref: repositoryRef().trim() }),
      ...(credentialId() === "" ? {} : { credentialId: credentialId() }),
      ...(subdirectory === "" ? {} : { subdirectory }),
    };
    setBusy(true);
    setError("");
    try {
      await installPackage(request);
    } catch (cause) {
      setOperationError(
        "Unable to install the package. Check the repository and GitHub access, then try again.",
        cause,
      );
    } finally {
      setBusy(false);
    }
  };

  const updatePackage = async (
    entry: ValidScriptPackage,
    replaceModified = false,
  ): Promise<void> => {
    const bridge = props.bridge;
    if (bridge === undefined) return;
    const result = await bridge
      .updatePackage({
        packageName: entry.name,
        ...(replaceModified ? { replaceModified: true } : {}),
      })
      .finally(refreshLeftovers);
    if (result.status === "confirmation-required") {
      askForConfirmation({
        confirmLabel: "Discard changes and update",
        description: `${entry.name} has local changes. Updating will replace the entire package and permanently discard your changes.`,
        destructive: true,
        onConfirm: () => updatePackage(entry, true),
        title: "Replace local changes?",
      });
      return;
    }
    applyMutation(result);
  };

  const confirmModifiedPackageUpdate = (entry: ValidScriptPackage): void => {
    const restoring = packagePrimaryAction(entry) === "restore";
    askForConfirmation({
      confirmLabel: restoring
        ? "Restore package"
        : "Discard changes and update",
      description: restoring
        ? `${entry.name} has local changes. Restoring will download the installed version from GitHub and permanently discard your changes.`
        : `${entry.name} has local changes. Updating will replace the entire package with the latest version from GitHub and permanently discard your changes.`,
      destructive: true,
      onConfirm: async () => {
        if (!restoring) return updatePackage(entry, true);
        const bridge = props.bridge;
        if (bridge === undefined) return;
        applyMutation(await bridge.restorePackage({ packageName: entry.name }));
      },
      title: restoring ? "Restore this package?" : "Replace local changes?",
    });
  };

  const beginUpdatePackage = (entry: ValidScriptPackage): void => {
    if (busy() || packageActiveRateLimit(entry) !== undefined) return;
    if (entry.integrity === "modified") {
      confirmModifiedPackageUpdate(entry);
      return;
    }
    setBusy(true);
    setError("");
    void updatePackage(entry)
      .catch((cause) =>
        setOperationError(`Failed to update ${entry.name}.`, cause),
      )
      .finally(() => setBusy(false));
  };

  const removePackage = (entry: ValidScriptPackage): void => {
    const bridge = props.bridge;
    if (bridge === undefined) return;
    confirmScriptPackageRemoval(entry, {
      askForConfirmation,
      removePackage: (request) =>
        bridge.removePackage(request).finally(refreshLeftovers),
      applyMutation: (result) => {
        applyMutation(result);
        if (result.status === "completed" || result.status === "unchanged") {
          setSelectedPackagePath(undefined);
          setPackageManagementView("installed");
        }
      },
    });
  };

  const checkUpdate = async (entry: ValidScriptPackage): Promise<void> => {
    if (packageActiveRateLimit(entry) !== undefined) return;
    const bridge = props.bridge;
    if (bridge === undefined) return;
    if (busy()) return;
    setBusy(true);
    setCheckingPackageName(entry.name);
    setError("");
    try {
      replaceCatalog(await bridge.checkPackageUpdate(entry.name));
    } catch (cause) {
      setOperationError(`Failed to check ${entry.name} for updates.`, cause);
    } finally {
      setCheckingPackageName(undefined);
      setBusy(false);
    }
  };

  const checkAllPackageUpdates = async (): Promise<void> => {
    const bridge = props.bridge;
    if (bridge === undefined) return;
    if (busy()) return;
    const packageNames = packagesEligibleForUpdateCheck().map(
      (entry) => entry.name,
    );
    if (packageNames.length === 0) return;

    setBusy(true);
    setCheckingPackageUpdates(true);
    setError("");
    try {
      const result = await checkScriptPackageUpdatesSerially(
        packageNames,
        async (packageName) => {
          const current = catalog().packages.find(
            (entry): entry is ValidScriptPackage =>
              entry.status === "valid" && entry.name === packageName,
          );
          if (
            current?.source === undefined ||
            packageActiveRateLimit(current) !== undefined
          ) {
            return "skipped";
          }
          replaceCatalog(await bridge.checkPackageUpdate(packageName));
          return "checked";
        },
      );
      if (result.failedCount > 0) {
        const message = formatScriptPackageUpdateCheckFailures(result);
        console.error("[game:scripts] Package update checks failed.", {
          failedCount: result.failedCount,
          succeededCount: result.succeededCount,
        });
        setError(message);
      }
    } finally {
      setCheckingPackageUpdates(false);
      setBusy(false);
    }
  };

  const openPackage = async (
    entry: Pick<ScriptPackageSummary, "path">,
  ): Promise<void> => {
    try {
      if (!(await props.bridge?.openPath(entry.path))) {
        throw new Error("The package folder could not be opened.");
      }
    } catch (cause) {
      setOperationError("Failed to open the package folder.", cause);
    }
  };

  const openScript = async (entry: ScriptCatalogEntry): Promise<void> => {
    try {
      const bridge = props.bridge;
      if (bridge === undefined) return;
      if (!(await bridge.openPath(entry.path))) {
        throw new Error("The script could not be opened.");
      }
    } catch (cause) {
      setOperationError(
        "Failed to open the script in your default editor.",
        cause,
      );
    }
  };

  const openRepository = async (entry: ValidScriptPackage): Promise<void> => {
    const repositoryUrl = entry.source?.repositoryUrl;
    if (repositoryUrl === undefined) return;
    try {
      const bridge = props.bridge;
      if (bridge === undefined) return;
      if (!(await bridge.openRepository(repositoryUrl))) {
        throw new Error("The repository could not be opened.");
      }
    } catch (cause) {
      setOperationError("Failed to open the package repository.", cause);
    }
  };

  const runPackagePrimaryAction = (
    entry: ValidScriptPackage,
    action: PackagePrimaryAction,
  ): void => {
    switch (action) {
      case "check":
        void checkUpdate(entry);
        return;
      case "open-folder":
        void openPackage(entry);
        return;
      case "restore":
      case "update":
        beginUpdatePackage(entry);
    }
  };

  const openPackageInstaller = (): void => {
    setInstallOptionsOpen(
      packageDirectory().trim() !== "" || repositoryRef().trim() !== "",
    );
    setSelectedPackagePath(undefined);
    setPackageManagementView("installed");
    setRepositoryValidationAttempted(false);
    setError("");
    setPackageTask({ view: "install" });
  };

  const openPackageInstallerFromLibrary = (): void => {
    changeActiveTab("packages");
    queueMicrotask(() => {
      packageInstallButton?.focus({ preventScroll: true });
      openPackageInstaller();
    });
  };

  const openPackageDetails = (entry: ScriptPackageSummary): void => {
    setSelectedPackagePath(entry.path);
    setError("");
    setPackageManagementView("details");
  };

  const closePackageDetails = (): void => {
    if (busy()) return;
    setSelectedPackagePath(undefined);
    setError("");
    setPackageManagementView("installed");
  };

  const resetCredentialDraft = (): void => {
    setEditingCredentialId("");
    setCredentialLabel("");
    setCredentialToken("");
    setCredentialFormErrors({});
    setCredentialTokenVisible(false);
  };

  const closePackageTask = (): void => {
    if (busy()) return;
    resetCredentialDraft();
    setRepositoryValidationAttempted(false);
    setError("");
    setPackageTask({ view: "closed" });
  };

  const openCredentialEditor = (
    entry?: GitHubCredentialSummary,
    returnView: "install" | "tokens" = "tokens",
  ): void => {
    setError("");
    setEditingCredentialId(entry?.id ?? "");
    setCredentialLabel(entry?.label ?? "");
    setCredentialToken("");
    setCredentialFormErrors({});
    setCredentialTokenVisible(false);
    setPackageTask({ returnView, view: "token-editor" });
  };

  const closeCredentialEditor = (): void => {
    if (busy()) return;
    const task = packageTask();
    const returnView =
      task.view === "token-editor" ? task.returnView : "tokens";
    resetCredentialDraft();
    setError("");
    setPackageTask({ view: returnView });
  };

  const openCredentialManager = (): void => {
    resetCredentialDraft();
    setError("");
    setPackageTask({ view: "tokens" });
  };

  const saveCredential = async (): Promise<void> => {
    const bridge = props.bridge;
    if (bridge === undefined) return;
    if (busy()) return;
    const task = packageTask();
    if (task.view !== "token-editor") return;
    const nextErrors: CredentialFormErrors = {
      ...(editingCredentialId() === "" && credentialLabel().trim() === ""
        ? { label: "Enter a name." }
        : {}),
      ...(credentialToken().trim() === "" ? { token: "Enter a token." } : {}),
    };
    setCredentialFormErrors(nextErrors);
    setError("");
    const firstInvalidInput = nextErrors.label
      ? credentialLabelInput
      : nextErrors.token
        ? credentialTokenInput
        : undefined;
    if (firstInvalidInput !== undefined) {
      window.requestAnimationFrame(() => firstInvalidInput.focus());
      return;
    }

    const returnView = task.returnView;
    setBusy(true);
    setError("");
    try {
      const saved = await bridge.saveCredential({
        ...(editingCredentialId() === "" ? {} : { id: editingCredentialId() }),
        label: credentialLabel().trim(),
        token: credentialToken().trim(),
      });
      setCredentials((current) =>
        [...current.filter((entry) => entry.id !== saved.id), saved].toSorted(
          (left, right) => left.label.localeCompare(right.label),
        ),
      );
      if (returnView === "install") setCredentialId(saved.id);
      resetCredentialDraft();
      setPackageTask({ view: returnView });
    } catch (cause) {
      setOperationError(
        "Unable to save the GitHub token. Check the token and try again.",
        cause,
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteCredential = (entry: GitHubCredentialSummary): void => {
    askForConfirmation({
      confirmLabel: "Delete token",
      description: `Delete ${entry.label}? Packages that use it will stay installed, but Lucent won't be able to check for updates. Reinstall those packages with another token to resume update checks.`,
      destructive: true,
      onConfirm: async () => {
        const bridge = props.bridge;
        if (bridge === undefined) return;
        await bridge.deleteCredential(entry.id);
        setCredentials((current) =>
          current.filter((candidate) => candidate.id !== entry.id),
        );
        if (credentialId() === entry.id) setCredentialId("");
        if (editingCredentialId() === entry.id) {
          resetCredentialDraft();
        }
        setConfirmation(null);
        window.requestAnimationFrame(() => manageTokensAddButton?.focus());
      },
      title: "Delete this token?",
    });
  };

  const resetDialogViewState = (): void => {
    setConfirmation(null);
    resetCredentialDraft();
    setPackageTask({ view: "closed" });
    setInstallOptionsOpen(false);
    setSelectedPackagePath(undefined);
    setPackageManagementView("installed");
    setRoomEditingMode(null);
  };

  let scriptsDialogWasOpen = props.open;
  createEffect(() => {
    const open = props.open;
    if (scriptsDialogWasOpen && !open) resetDialogViewState();
    scriptsDialogWasOpen = open;
  });

  const handleRoomModeChange = (value: string): void => {
    if (value === "specific") {
      setRoomEditingMode("specific");
      props.onSetRoomNumberDraft(
        props.roomPolicy.kind === "specific"
          ? String(props.roomPolicy.roomNumber)
          : "",
      );
      return;
    }
    if (value === "public" || value === "random-private") {
      setRoomEditingMode(null);
      props.onSelectRoomPolicy({ kind: value });
    }
  };

  const toggleCurrentScript = (): void => {
    if (!props.scriptRunning) props.onOpenChange(false);
    void props.onToggleScript();
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(details) => {
        if (busy()) return;
        if (!details.open) resetDialogViewState();
        props.onOpenChange(details.open);
      }}
    >
      <DialogContent
        class="game-scripts-dialog"
        closeProps={{ disabled: busy() }}
      >
        <div class="game-scripts-dialog__layout">
          <DialogHeader class="game-scripts-dialog__header">
            <div class="game-scripts-dialog__title-row">
              <DialogTitle class="visually-hidden">Scripts</DialogTitle>
              <div
                class="game-scripts-dialog__current-script"
                data-loaded={props.scriptLoaded ? "" : undefined}
                data-running={props.scriptRunning ? "" : undefined}
              >
                <DialogDescription
                  aria-live="polite"
                  title={displayScriptSourceText(props.scriptStatus)}
                >
                  {displayScriptSourceText(props.scriptStatus)}
                </DialogDescription>
              </div>
              <div class="game-scripts-dialog__common-actions">
                <div class="game-scripts-dialog__load-run-actions">
                  <Button
                    disabled={busy() || props.scriptBusy}
                    onClick={chooseFile}
                    size="sm"
                    variant={props.scriptLoaded ? "secondary" : "default"}
                  >
                    Load script...
                  </Button>
                  <Button
                    disabled={
                      !props.scriptLoaded ||
                      busy() ||
                      props.scriptBusy ||
                      (!props.scriptRunning && !props.optionsReady)
                    }
                    onClick={toggleCurrentScript}
                    size="sm"
                    variant={props.scriptRunning ? "destructive" : "default"}
                  >
                    {props.scriptRunning ? "Stop" : "Start"}
                  </Button>
                </div>
                <span class="game-scripts-dialog__action-divider" />
                <Button
                  disabled={
                    !props.inputsAvailable ||
                    props.scriptRunning ||
                    busy() ||
                    props.scriptBusy
                  }
                  onClick={() => {
                    props.onOpenChange(false);
                    props.onEditInputs();
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Edit inputs
                </Button>
              </div>
            </div>
          </DialogHeader>

          <div class="game-scripts-dialog__alert-slot">
            <Show
              when={
                error() !== "" && confirmation() === null && !packageTaskOpen()
              }
            >
              <ErrorAlert
                class="game-scripts-dialog__alert"
                message={error()}
              />
            </Show>
          </div>

          <Tabs
            class="game-scripts-dialog__tabs"
            value={activeTab()}
            onValueChange={(details) => changeActiveTab(details.value)}
          >
            <TabsList variant="underline">
              <TabsTrigger value="scripts">Library</TabsTrigger>
              <TabsTrigger aria-label={queueTabLabel()} value="queue">
                Queue
                <Show when={queueEntryCount() > 0}>
                  <Badge
                    aria-hidden="true"
                    class="game-scripts-dialog__queue-count"
                    size="sm"
                    variant="secondary"
                  >
                    {queueBadgeText()}
                  </Badge>
                </Show>
              </TabsTrigger>
              <TabsTrigger value="packages">Packages</TabsTrigger>
              <TabsTrigger value="options">Options</TabsTrigger>
            </TabsList>
            <div aria-atomic="true" class="visually-hidden" role="status">
              {queueAnnouncement()}
            </div>
            <TabsContent
              class="game-scripts-dialog__tab-content game-scripts-dialog__scripts"
              value="scripts"
            >
              <div class="game-scripts-dialog__script-toolbar">
                <InputGroup class="game-scripts-dialog__script-search">
                  <InputGroupInput
                    aria-label="Search scripts"
                    placeholder="Search scripts..."
                    value={search()}
                    onInput={(event) =>
                      updateScriptSearch(event.currentTarget.value)
                    }
                  />
                  <InputGroupAddon align="inline-start" aria-live="polite">
                    <Show
                      when={scriptQueryIndicatorVisible()}
                      fallback={<Icon aria-hidden="true" icon="search" />}
                    >
                      <Spinner size="sm" />
                      <span class="visually-hidden">Searching scripts...</span>
                    </Show>
                  </InputGroupAddon>
                </InputGroup>
                <CatalogRefreshButton
                  disabled={busy() || catalogLoading()}
                  loading={catalogLoading() && catalog().revision !== ""}
                  onClick={() => void refreshCatalog()}
                />
              </div>
              <div
                ref={mountScriptViewport}
                aria-busy={scriptQueryLoading() ? "true" : undefined}
                class="game-scripts-dialog__script-viewport"
                onScroll={(event) => {
                  if (activeTab() === "scripts") {
                    scrollPositions.scripts = event.currentTarget.scrollTop;
                    requestScriptViewport(event.currentTarget);
                  }
                }}
              >
                <Show
                  when={catalog().revision !== "" || !catalogLoading()}
                  fallback={
                    <div
                      class="game-scripts-dialog__empty game-scripts-dialog__loading"
                      role="status"
                    >
                      <Spinner size="sm" />
                      <span>Loading scripts...</span>
                    </div>
                  }
                >
                  <Show
                    when={scriptTotal() > 0}
                    fallback={
                      <div class="game-scripts-dialog__empty game-scripts-dialog__collection-empty">
                        <p class="game-scripts-dialog__collection-empty-title">
                          {catalogQuery() === ""
                            ? "No scripts found"
                            : "No matching scripts"}
                        </p>
                        <Show
                          when={catalogQuery() === ""}
                          fallback={
                            <Button
                              onClick={clearScriptSearch}
                              size="sm"
                              variant="secondary"
                            >
                              Clear search
                            </Button>
                          }
                        >
                          <p class="game-scripts-dialog__collection-empty-description">
                            Load a file or install a package.
                          </p>
                          <div class="game-scripts-dialog__collection-empty-actions">
                            <Button onClick={chooseFile} size="sm">
                              Load script...
                            </Button>
                            <Button
                              onClick={openPackageInstallerFromLibrary}
                              size="sm"
                              variant="secondary"
                            >
                              Install package
                            </Button>
                          </div>
                        </Show>
                      </div>
                    }
                  >
                    <div
                      class="game-scripts-dialog__virtual-list"
                      style={{
                        height: `${scriptVirtualizer.getTotalSize()}px`,
                      }}
                    >
                      <For each={scriptVirtualizer.getVirtualItems()}>
                        {(virtualRow) => {
                          const entry = () =>
                            scriptCatalogEntryAt(
                              scriptPages(),
                              virtualRow.index,
                            );
                          return (
                            <Show
                              when={entry()}
                              keyed
                              fallback={
                                <div
                                  aria-hidden="true"
                                  class="game-scripts-dialog__script-row game-scripts-dialog__script-row--loading"
                                  data-last={
                                    virtualRow.index === scriptTotal() - 1
                                      ? ""
                                      : undefined
                                  }
                                  style={{
                                    height: `${virtualRow.size}px`,
                                    transform: `translateY(${virtualRow.start}px)`,
                                  }}
                                >
                                  <div class="game-scripts-dialog__script-copy">
                                    <span />
                                    <span />
                                  </div>
                                </div>
                              }
                            >
                              {(script) => {
                                const selected = () =>
                                  sameReference(
                                    props.loadedReference,
                                    script.reference,
                                  );
                                const enqueueing = () =>
                                  sameReference(
                                    enqueueingReference(),
                                    script.reference,
                                  );
                                const recentlyQueued = () =>
                                  sameReference(
                                    recentlyQueuedReference(),
                                    script.reference,
                                  );
                                return (
                                  <div
                                    class="game-scripts-dialog__script-row"
                                    data-last={
                                      virtualRow.index === scriptTotal() - 1
                                        ? ""
                                        : undefined
                                    }
                                    data-selected={selected() ? "" : undefined}
                                    style={{
                                      height: `${virtualRow.size}px`,
                                      transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                  >
                                    <div class="game-scripts-dialog__script-copy">
                                      <button
                                        aria-label={`Open ${scriptLocation(script)} in your default editor`}
                                        class="game-scripts-dialog__script-path"
                                        onClick={() => void openScript(script)}
                                        title={script.path}
                                        type="button"
                                      >
                                        <Show
                                          when={scriptContext(script)}
                                          keyed
                                        >
                                          {(context) => (
                                            <>
                                              <span class="game-scripts-dialog__script-context">
                                                {truncatePathContext(
                                                  context,
                                                  scriptContextLimit(),
                                                )}
                                              </span>
                                              <span
                                                aria-hidden="true"
                                                class="game-scripts-dialog__script-separator"
                                              >
                                                /
                                              </span>
                                            </>
                                          )}
                                        </Show>
                                        <span class="game-scripts-dialog__script-name">
                                          {script.name}
                                        </span>
                                        <Icon
                                          aria-hidden="true"
                                          class="game-scripts-dialog__script-open-icon"
                                          icon="pencil"
                                          size="xs"
                                        />
                                      </button>
                                    </div>
                                    <div class="game-scripts-dialog__row-actions">
                                      <Button
                                        class="game-scripts-dialog__queue-add"
                                        data-added={
                                          recentlyQueued() ? "" : undefined
                                        }
                                        disabled={
                                          busy() ||
                                          props.scriptBusy ||
                                          props.queueState.phase !== "idle" ||
                                          recentlyQueued()
                                        }
                                        loading={enqueueing()}
                                        onClick={() =>
                                          void enqueueScript(script)
                                        }
                                        size="sm"
                                        variant="ghost"
                                      >
                                        <Show
                                          when={recentlyQueued()}
                                          fallback="Add to queue"
                                        >
                                          <Icon
                                            aria-hidden="true"
                                            icon="check"
                                            size="xs"
                                          />
                                          Added
                                        </Show>
                                      </Button>
                                      <Button
                                        disabled={
                                          busy() ||
                                          props.scriptBusy ||
                                          (selected() &&
                                            props.scriptRunning &&
                                            props.queueState.phase === "idle")
                                        }
                                        onClick={() =>
                                          selectScript(script, false)
                                        }
                                        size="sm"
                                        variant="outline"
                                      >
                                        Load
                                      </Button>
                                      <Button
                                        disabled={
                                          busy() ||
                                          props.scriptBusy ||
                                          (selected() &&
                                            props.scriptRunning &&
                                            props.queueState.phase ===
                                              "idle") ||
                                          !props.optionsReady
                                        }
                                        onClick={() =>
                                          selectScript(script, true)
                                        }
                                        size="sm"
                                      >
                                        Start
                                      </Button>
                                    </div>
                                  </div>
                                );
                              }}
                            </Show>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>
            </TabsContent>

            <TabsContent
              class="game-scripts-dialog__tab-content game-scripts-dialog__queue"
              value="queue"
            >
              <Show when={props.queueState.error} keyed>
                {(message) => <ErrorAlert message={message} />}
              </Show>
              <div class="game-scripts-dialog__queue-toolbar">
                <div
                  aria-live="polite"
                  class="game-scripts-dialog__queue-summary"
                >
                  <span>
                    {props.queueState.entries.length === 1
                      ? "1 script"
                      : `${props.queueState.entries.length} scripts`}
                  </span>
                </div>
                <div class="game-scripts-dialog__queue-actions">
                  <Show
                    when={props.queueState.phase === "idle"}
                    fallback={
                      <>
                        <Show when={props.queueState.phase === "paused"}>
                          <Button
                            onClick={props.onQueueRunNext}
                            size="sm"
                            variant="secondary"
                          >
                            Run next script
                          </Button>
                        </Show>
                        <Button
                          disabled={props.queueState.phase === "stopping"}
                          onClick={() => void props.onQueueStop()}
                          size="sm"
                          variant="destructive"
                        >
                          Stop queue
                        </Button>
                      </>
                    }
                  >
                    <>
                      <Button
                        disabled={
                          busy() || props.queueState.entries.length === 0
                        }
                        onClick={props.onQueueClear}
                        size="sm"
                        variant="ghost"
                      >
                        Clear queue
                      </Button>
                      <Button
                        disabled={
                          props.queueState.entries.length === 0 ||
                          !props.optionsReady
                        }
                        onClick={() => void props.onQueueStart()}
                        size="sm"
                      >
                        Start queue
                      </Button>
                    </>
                  </Show>
                </div>
              </div>

              <Show
                when={props.queueState.entries.length > 0}
                fallback={
                  <div class="game-scripts-dialog__empty game-scripts-dialog__collection-empty">
                    <p class="game-scripts-dialog__collection-empty-title">
                      Queue is empty
                    </p>
                    <p class="game-scripts-dialog__collection-empty-description">
                      Add scripts from the Library tab.
                    </p>
                    <Button
                      onClick={() => changeActiveTab("scripts")}
                      size="sm"
                      variant="secondary"
                    >
                      Browse scripts
                    </Button>
                  </div>
                }
              >
                <ScriptQueueList
                  ref={(api) => {
                    queueList = api;
                  }}
                  active={props.open && activeTab() === "queue"}
                  isAttentionItem={(entry) =>
                    props.queueState.attentionEntryId === entry.id
                  }
                  itemKey={(entry) => entry.id}
                  items={props.queueState.entries}
                  label="Queue"
                >
                  {(entry, index) => {
                    const runItem = () => queueRunItems().get(entry.id);
                    const status = () => {
                      const item = runItem();
                      return item !== undefined &&
                        (item.state !== "pending" ||
                          props.queueState.phase !== "idle")
                        ? queueItemStatus(item)
                        : undefined;
                    };
                    return (
                      <>
                        <span class="game-scripts-dialog__queue-copy">
                          <Tooltip
                            closeDelay={0}
                            openDelay={400}
                            positioning={{ placement: "bottom-start" }}
                            unmountOnExit
                          >
                            <TooltipTrigger
                              asChild={(triggerProps) => (
                                <span
                                  {...triggerProps({
                                    class: "game-scripts-dialog__queue-name",
                                  })}
                                >
                                  {entry.file.name}
                                </span>
                              )}
                            />
                            <TooltipContent class="game-scripts-dialog__queue-path-tooltip">
                              {entry.file.path}
                            </TooltipContent>
                          </Tooltip>
                          <Show when={status()} keyed>
                            {(value) => (
                              <span
                                class="game-scripts-dialog__queue-status"
                                title={value}
                              >
                                {value}
                              </span>
                            )}
                          </Show>
                        </span>
                        <span class="game-scripts-dialog__queue-row-trailing">
                          <Show when={runItem()}>
                            {(item) => (
                              <Show when={queueItemDuration(item())}>
                                {(duration) => (
                                  <span
                                    class="game-scripts-dialog__queue-duration"
                                    title={queueItemFinishedAt(item())}
                                  >
                                    {duration()}
                                  </span>
                                )}
                              </Show>
                            )}
                          </Show>
                          <Show when={props.queueState.phase === "idle"}>
                            <span class="game-scripts-dialog__queue-row-actions">
                              <Button
                                aria-label={`Edit inputs for ${entry.file.name}`}
                                disabled={!entry.inputsAvailable}
                                onClick={() =>
                                  void props.onQueueEditInputs(entry.id)
                                }
                                size="xs"
                                variant="ghost"
                              >
                                Edit
                              </Button>
                              <IconButton
                                aria-label={`Move ${entry.file.name} up`}
                                disabled={index() === 0}
                                onClick={(event) => {
                                  const button = event.currentTarget;
                                  props.onQueueMove(entry.id, -1);
                                  queueMicrotask(() => button.focus());
                                }}
                                size="icon-xs"
                                variant="ghost"
                              >
                                <Icon icon="arrow_up" size="xs" />
                              </IconButton>
                              <IconButton
                                aria-label={`Move ${entry.file.name} down`}
                                disabled={
                                  index() ===
                                  props.queueState.entries.length - 1
                                }
                                onClick={(event) => {
                                  const button = event.currentTarget;
                                  props.onQueueMove(entry.id, 1);
                                  queueMicrotask(() => button.focus());
                                }}
                                size="icon-xs"
                                variant="ghost"
                              >
                                <Icon icon="arrow_down" size="xs" />
                              </IconButton>
                              <IconButton
                                aria-label={`Remove ${entry.file.name}`}
                                onClick={() => props.onQueueRemove(entry.id)}
                                size="icon-xs"
                                variant="ghost"
                              >
                                <Icon icon="trash_2" size="xs" />
                              </IconButton>
                            </span>
                          </Show>
                        </span>
                      </>
                    );
                  }}
                </ScriptQueueList>
              </Show>
            </TabsContent>

            <TabsContent
              class="game-scripts-dialog__tab-content game-scripts-dialog__options-view"
              value="options"
            >
              <section
                aria-labelledby="game-scripts-dialog-options-title"
                class="game-scripts-dialog__options"
              >
                <div class="game-scripts-dialog__options-heading">
                  <div class="game-scripts-dialog__options-heading-copy">
                    <span
                      class="game-scripts-dialog__section-title"
                      id="game-scripts-dialog-options-title"
                    >
                      Script behavior
                    </span>
                    <p>Set per-account script preferences.</p>
                  </div>
                  <span
                    aria-atomic="true"
                    class="visually-hidden"
                    role="status"
                  >
                    {!props.loggedIn
                      ? "Log in to change script preferences."
                      : props.optionsSaveStatus === "saving"
                        ? "Saving script preferences."
                        : props.optionsSaveStatus === "failed"
                          ? "Couldn't save script preferences. Changes last only for this session."
                          : ""}
                  </span>
                  <Show
                    when={!props.loggedIn || props.optionsSaveStatus !== "idle"}
                  >
                    <div class="game-scripts-dialog__options-save-feedback">
                      <Show
                        when={props.loggedIn}
                        fallback={
                          <span class="game-scripts-dialog__options-save-status">
                            Log in to change script preferences.
                          </span>
                        }
                      >
                        <div class="game-scripts-dialog__options-save-summary">
                          <span
                            class="game-scripts-dialog__options-save-status"
                            data-state={props.optionsSaveStatus}
                          >
                            {props.optionsSaveStatus === "saving"
                              ? "Saving…"
                              : "Couldn't save"}
                          </span>
                          <Show when={props.optionsSaveStatus === "failed"}>
                            <Button
                              class="game-scripts-dialog__options-save-retry"
                              onClick={props.onRetryOptionsSave}
                              size="sm"
                              variant="link"
                            >
                              Retry
                            </Button>
                          </Show>
                        </div>
                        <Show when={props.optionsSaveStatus === "failed"}>
                          <span class="game-scripts-dialog__options-save-note">
                            Changes last only for this session.
                          </span>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </div>
                <div class="game-scripts-dialog__options-list">
                  <div class="game-scripts-dialog__option-row">
                    <div class="game-scripts-dialog__option-copy">
                      <span
                        class="game-scripts-dialog__option-title"
                        id="script-option-safe-start-stop-title"
                      >
                        Safe start and stop
                      </span>
                      <span
                        class="game-scripts-dialog__option-description"
                        id="script-option-safe-start-stop-description"
                      >
                        Best effort attempt to start or stop the script at your
                        house.
                      </span>
                    </div>
                    <div class="game-scripts-dialog__option-action">
                      <Switch
                        aria-labelledby="script-option-safe-start-stop-title script-option-safe-start-stop-description"
                        checked={props.safeStartStop}
                        disabled={!props.optionsReady}
                        onChange={props.onToggleSafeStartStop}
                      />
                    </div>
                  </div>
                  <div class="game-scripts-dialog__option-row">
                    <div class="game-scripts-dialog__option-copy">
                      <span
                        class="game-scripts-dialog__option-title"
                        id="script-option-reconnect-title"
                      >
                        Restart after reconnecting
                      </span>
                      <span
                        class="game-scripts-dialog__option-description"
                        id="script-option-reconnect-description"
                      >
                        Restart the active script when the same account
                        reconnects.
                      </span>
                    </div>
                    <div class="game-scripts-dialog__option-action">
                      <Switch
                        aria-labelledby="script-option-reconnect-title script-option-reconnect-description"
                        checked={props.restartAfterReconnect}
                        disabled={!props.optionsReady}
                        onChange={props.onToggleRestartAfterReconnect}
                      />
                    </div>
                  </div>
                  <div class="game-scripts-dialog__option-row">
                    <div class="game-scripts-dialog__option-copy">
                      <span class="game-scripts-dialog__option-title">
                        Rooms
                      </span>
                      <span class="game-scripts-dialog__option-description">
                        Choose which rooms scripts join.
                      </span>
                    </div>
                    <div class="game-scripts-dialog__option-action">
                      <Select
                        class="game-scripts-dialog__room-policy-select"
                        disabled={!props.optionsReady}
                        ids={{ trigger: "script-room-policy" }}
                        value={[roomMode()]}
                        onValueChange={(details) => {
                          const value = details.value[0];
                          if (value !== undefined) {
                            handleRoomModeChange(value);
                          }
                        }}
                      >
                        <SelectTrigger aria-label="Rooms" size="sm">
                          <span class="select__value">
                            {roomPolicyLabels[roomMode()]}
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="public">
                            {roomPolicyLabels.public}
                          </SelectItem>
                          <SelectItem value="random-private">
                            {roomPolicyLabels["random-private"]}
                          </SelectItem>
                          <SelectItem value="specific">
                            {roomPolicyLabels.specific}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Show when={roomMode() === "specific"}>
                    <div class="game-scripts-dialog__room-number-suboption">
                      <div class="game-scripts-dialog__option-copy">
                        <label
                          class="game-scripts-dialog__option-title"
                          for="script-room-number"
                        >
                          Room number
                        </label>
                        <span
                          class="game-scripts-dialog__room-number-feedback"
                          data-invalid={roomMessage() !== "" ? "" : undefined}
                          id="script-room-number-feedback"
                        >
                          {roomMessage() ||
                            (roomKind() === "public"
                              ? "This number selects a public room."
                              : roomKind() === "private"
                                ? "This number selects a private room."
                                : "Enter a room number from 1 to 99,999.")}
                        </span>
                      </div>
                      <Input
                        aria-describedby="script-room-number-feedback"
                        class="game-scripts-dialog__room-number-input"
                        disabled={!props.optionsReady}
                        id="script-room-number"
                        inputMode="numeric"
                        invalid={roomMessage() !== ""}
                        maxLength={5}
                        size="sm"
                        value={props.roomNumberDraft}
                        onBlur={props.onCommitRoomNumber}
                        onInput={(event) =>
                          props.onSetRoomNumberDraft(event.currentTarget.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          props.onCommitRoomNumber();
                        }}
                      />
                    </div>
                  </Show>
                </div>
              </section>
            </TabsContent>

            <TabsContent
              class="game-scripts-dialog__tab-content game-scripts-dialog__packages"
              value="packages"
            >
              <Show when={packageManagementView() === "installed"}>
                <div
                  aria-label="Package actions"
                  class="game-scripts-dialog__package-toolbar"
                  role="toolbar"
                >
                  <div class="game-scripts-dialog__package-toolbar-group">
                    <Button
                      ref={(element) => {
                        packageInstallButton = element;
                      }}
                      disabled={busy() || catalogLoading()}
                      onClick={openPackageInstaller}
                      size="sm"
                    >
                      <Icon icon="plus" size="sm" />
                      Install package
                    </Button>
                    <Show when={hasManagedPackages()}>
                      <PackageUpdateCheckButton
                        checking={checkingPackageUpdates()}
                        disabled={
                          busy() ||
                          catalogLoading() ||
                          packagesEligibleForUpdateCheck().length === 0
                        }
                        label="Check for updates"
                        onClick={() => void checkAllPackageUpdates()}
                        variant="secondary"
                      />
                    </Show>
                  </div>
                  <div class="game-scripts-dialog__package-toolbar-actions">
                    <Menu positioning={{ gutter: 4, placement: "bottom-end" }}>
                      <MenuTrigger
                        asChild={(triggerProps) => (
                          <IconButton
                            {...(triggerProps({
                              "aria-label": "More package actions",
                              children: <Icon icon="ellipsis" size="sm" />,
                              disabled: busy(),
                              size: "icon",
                              title: "More package actions",
                              type: "button",
                              variant: "outline",
                            } as IconButtonProps) as IconButtonProps)}
                          />
                        )}
                      />
                      <MenuContent>
                        <MenuItem
                          onSelect={() => queueMicrotask(openCredentialManager)}
                          value="manage-github-tokens"
                        >
                          Manage GitHub tokens
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                    <CatalogRefreshButton
                      disabled={busy() || catalogLoading()}
                      loading={catalogLoading() && catalog().revision !== ""}
                      onClick={() => void refreshCatalog()}
                    />
                  </div>
                </div>
                <Show
                  when={leftoverCopies().length > 0 || leftoverError() !== ""}
                >
                  <Alert
                    class="game-scripts-dialog__package-notice"
                    variant="warning"
                  >
                    <AlertTitle>Leftover package folders</AlertTitle>
                    <AlertDescription>
                      <Show when={leftoverError() !== ""}>
                        <p>{leftoverError()}</p>
                      </Show>
                      <Show when={leftoverCopies().length > 0}>
                        An update or removal didn't finish. These folders hold
                        the old package files. Another open copy of Lucent may
                        still be using them.
                        <ul class="game-scripts-dialog__package-leftovers">
                          <For each={leftoverCopies()}>
                            {(copy) => (
                              <li>
                                <span title={copy.path}>
                                  {copy.packageName ??
                                    copy.path.split(/[\\/]/u).at(-1)}
                                </span>
                                <Button
                                  aria-label={`Open folder for ${copy.packageName ?? copy.path.split(/[\\/]/u).at(-1)}`}
                                  onClick={() => void openPackage(copy)}
                                  size="sm"
                                  variant="secondary"
                                >
                                  <Icon icon="folder_open" size="sm" />
                                  Open folder
                                </Button>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </AlertDescription>
                  </Alert>
                </Show>
              </Show>

              <Show
                when={
                  packageManagementView() === "details"
                    ? selectedPackage()
                    : undefined
                }
                keyed
              >
                {(entry) => (
                  <section
                    ref={mountPackageViewport}
                    aria-label="Package details"
                    class="game-scripts-dialog__package-details"
                    onScroll={(event) => {
                      if (activeTab() === "packages") {
                        scrollPositions.packages =
                          event.currentTarget.scrollTop;
                      }
                    }}
                  >
                    <Button
                      class="game-scripts-dialog__package-details-back"
                      disabled={busy()}
                      onClick={closePackageDetails}
                      size="sm"
                      variant="ghost"
                    >
                      <Icon icon="arrow_left" size="xs" />
                      Packages
                    </Button>
                    <Show
                      when={entry.status === "valid" ? entry : undefined}
                      keyed
                      fallback={
                        <>
                          <header class="game-scripts-dialog__package-details-heading">
                            <div class="game-scripts-dialog__package-details-identity">
                              <span class="game-scripts-dialog__package-name">
                                {entry.name ?? "Invalid package"}
                              </span>
                              <p>Lucent couldn't load this package.</p>
                            </div>
                          </header>
                          <Alert
                            class="game-scripts-dialog__package-notice"
                            variant="error"
                          >
                            <AlertTitle>
                              <Icon icon="triangle_alert" size="md" />
                              Needs attention
                            </AlertTitle>
                            <AlertDescription>
                              {entry.status === "invalid"
                                ? entry.diagnostic
                                : "This folder isn't a valid package."}
                            </AlertDescription>
                          </Alert>
                          <dl class="game-scripts-dialog__package-detail-list">
                            <div class="game-scripts-dialog__package-detail-row">
                              <dt>Location</dt>
                              <dd>
                                <span title={entry.path}>{entry.path}</span>
                              </dd>
                            </div>
                          </dl>
                          <div class="game-scripts-dialog__package-detail-actions">
                            <Button
                              onClick={() => void openPackage(entry)}
                              size="sm"
                              variant="secondary"
                            >
                              <Icon icon="folder_open" size="sm" />
                              Open folder
                            </Button>
                          </div>
                        </>
                      }
                    >
                      {(valid) => {
                        const displayStatus = createMemo(() =>
                          packageDisplayStatus(valid, rateLimitNow()),
                        );
                        const checkSummary = createMemo(() =>
                          packageCheckSummary(valid, rateLimitNow()),
                        );
                        const noticeDescription = createMemo(() =>
                          packageNoticeDescription(valid, displayStatus()),
                        );
                        return (
                          <>
                            <header class="game-scripts-dialog__package-details-heading">
                              <div class="game-scripts-dialog__package-details-identity">
                                <div class="game-scripts-dialog__package-details-title">
                                  <span class="game-scripts-dialog__package-name">
                                    {valid.name}
                                  </span>
                                  <Show when={valid.version} keyed>
                                    {(version) => (
                                      <span class="game-scripts-dialog__package-version">
                                        v{version}
                                      </span>
                                    )}
                                  </Show>
                                  <Show when={!needsPackageNotice(valid)}>
                                    <Badge
                                      class="game-scripts-dialog__package-status-badge"
                                      size="default"
                                      variant={displayStatus().tone}
                                    >
                                      {displayStatus().label}
                                    </Badge>
                                  </Show>
                                </div>
                                <Show when={valid.description} keyed>
                                  {(description) => (
                                    <p title={description}>{description}</p>
                                  )}
                                </Show>
                              </div>
                            </header>
                            <Show when={needsPackageNotice(valid)}>
                              <Alert
                                class="game-scripts-dialog__package-notice"
                                variant={packageAlertVariant(displayStatus())}
                              >
                                <AlertTitle>
                                  <Icon icon={displayStatus().icon} size="md" />
                                  {displayStatus().label}
                                </AlertTitle>
                                <AlertDescription>
                                  {noticeDescription()}
                                </AlertDescription>
                                <Show
                                  when={valid.update.status === "available"}
                                >
                                  <AlertAction>
                                    <Button
                                      disabled={
                                        busy() ||
                                        packageActiveRateLimit(valid) !==
                                          undefined
                                      }
                                      onClick={() => beginUpdatePackage(valid)}
                                      size="sm"
                                    >
                                      Update
                                    </Button>
                                  </AlertAction>
                                </Show>
                              </Alert>
                            </Show>
                            <dl class="game-scripts-dialog__package-detail-list">
                              <Show
                                when={valid.source}
                                keyed
                                fallback={
                                  <div class="game-scripts-dialog__package-detail-row">
                                    <dt>Source</dt>
                                    <dd>Local folder</dd>
                                  </div>
                                }
                              >
                                {(source) => {
                                  const revisionLabel =
                                    source.kind === "repository"
                                      ? "Commit"
                                      : "Tree";
                                  const revision =
                                    source.kind === "repository"
                                      ? source.resolvedCommit
                                      : source.resolvedTree;
                                  return (
                                    <>
                                      <div class="game-scripts-dialog__package-detail-row">
                                        <dt>Source</dt>
                                        <dd class="game-scripts-dialog__package-source">
                                          <span class="game-scripts-dialog__package-source-identity">
                                            <span class="game-scripts-dialog__package-source-reference">
                                              <Button
                                                aria-label={`Open ${valid.name} repository`}
                                                class="game-scripts-dialog__package-source-repository"
                                                onClick={() =>
                                                  void openRepository(valid)
                                                }
                                                size="xs"
                                                title={source.repositoryUrl}
                                                variant="link"
                                              >
                                                <span class="game-scripts-dialog__package-source-repository-label">
                                                  {source.repositoryUrl
                                                    .replace(
                                                      /^https:\/\/github\.com\//,
                                                      "",
                                                    )
                                                    .replace(/\/$/, "")}
                                                </span>
                                                <Show
                                                  when={source.requestedRef}
                                                  keyed
                                                >
                                                  {(requestedRef) => (
                                                    <span class="game-scripts-dialog__package-source-ref">
                                                      ({requestedRef})
                                                    </span>
                                                  )}
                                                </Show>
                                                <Icon
                                                  aria-hidden="true"
                                                  class="game-scripts-dialog__external-link-icon"
                                                  icon="arrow_up_right"
                                                  size="xs"
                                                />
                                              </Button>
                                            </span>
                                            <span class="game-scripts-dialog__package-source-revision">
                                              <span class="game-scripts-dialog__package-source-revision-label">
                                                {revisionLabel}
                                              </span>
                                              <code
                                                class="game-scripts-dialog__package-detail-mono"
                                                title={revision}
                                              >
                                                {revision.slice(0, 7)}
                                              </code>
                                              <TooltipIconButton
                                                aria-label={`Copy ${revisionLabel.toLowerCase()} ${revision}`}
                                                class="game-scripts-dialog__package-source-copy"
                                                onClick={() =>
                                                  void copyRevision(
                                                    valid.path,
                                                    revision,
                                                  )
                                                }
                                                size="icon-xs"
                                                tooltip={
                                                  copiedRevisionPath() ===
                                                  valid.path
                                                    ? "Copied"
                                                    : `Copy ${revisionLabel.toLowerCase()}`
                                                }
                                              >
                                                <Icon
                                                  icon={
                                                    copiedRevisionPath() ===
                                                    valid.path
                                                      ? "check"
                                                      : "copy"
                                                  }
                                                  size="xs"
                                                />
                                              </TooltipIconButton>
                                            </span>
                                          </span>
                                        </dd>
                                      </div>
                                      <Show
                                        when={
                                          source.kind === "directory"
                                            ? source.subdirectory
                                            : undefined
                                        }
                                        keyed
                                      >
                                        {(subdirectory) => (
                                          <div class="game-scripts-dialog__package-detail-row">
                                            <dt>Package directory</dt>
                                            <dd>
                                              <code class="game-scripts-dialog__package-detail-mono">
                                                {subdirectory}
                                              </code>
                                            </dd>
                                          </div>
                                        )}
                                      </Show>
                                    </>
                                  );
                                }}
                              </Show>
                              <Show when={checkSummary().timestamp} keyed>
                                {(timestamp) => (
                                  <div class="game-scripts-dialog__package-detail-row">
                                    <dt>{checkSummary().timestampLabel}</dt>
                                    <dd>
                                      <time
                                        datetime={timestamp}
                                        title={new Date(
                                          timestamp,
                                        ).toLocaleString()}
                                      >
                                        {formatRelativeTime(
                                          timestamp,
                                          rateLimitNow(),
                                        )}
                                      </time>
                                    </dd>
                                  </div>
                                )}
                              </Show>
                            </dl>
                            <div
                              aria-label="Package actions"
                              class="game-scripts-dialog__package-detail-actions"
                              role="toolbar"
                            >
                              <div class="game-scripts-dialog__package-detail-actions-group">
                                <Show
                                  when={packageFooterPrimaryAction(valid)}
                                  keyed
                                >
                                  {(action) =>
                                    action === "check" ? (
                                      <PackageUpdateCheckButton
                                        checking={
                                          checkingPackageName() === valid.name
                                        }
                                        disabled={
                                          busy() ||
                                          packageActiveRateLimit(valid) !==
                                            undefined
                                        }
                                        label={packageActionLabel(
                                          valid,
                                          action,
                                        )}
                                        onClick={() =>
                                          runPackagePrimaryAction(valid, action)
                                        }
                                        title={packageRateLimitTitle(
                                          packageActiveRateLimit(valid),
                                        )}
                                        variant="secondary"
                                      />
                                    ) : (
                                      <Button
                                        disabled={
                                          busy() ||
                                          packageActiveRateLimit(valid) !==
                                            undefined
                                        }
                                        onClick={() =>
                                          runPackagePrimaryAction(valid, action)
                                        }
                                        size="sm"
                                        title={packageRateLimitTitle(
                                          packageActiveRateLimit(valid),
                                        )}
                                        variant={
                                          action === "update"
                                            ? "default"
                                            : "secondary"
                                        }
                                      >
                                        {packageActionLabel(valid, action)}
                                      </Button>
                                    )
                                  }
                                </Show>
                                <Show
                                  when={
                                    packagePrimaryAction(valid) !==
                                    "open-folder"
                                  }
                                >
                                  <Button
                                    onClick={() => void openPackage(valid)}
                                    size="sm"
                                    variant="secondary"
                                  >
                                    <Icon icon="folder_open" size="sm" />
                                    Open folder
                                  </Button>
                                </Show>
                                <Show
                                  when={
                                    valid.source !== undefined &&
                                    packagePrimaryAction(valid) !== "check"
                                  }
                                >
                                  <PackageUpdateCheckButton
                                    checking={
                                      checkingPackageName() === valid.name
                                    }
                                    disabled={
                                      busy() ||
                                      packageActiveRateLimit(valid) !==
                                        undefined
                                    }
                                    label={packageUpdateCheckLabel(valid)}
                                    onClick={() => void checkUpdate(valid)}
                                    title={packageRateLimitTitle(
                                      packageActiveRateLimit(valid),
                                    )}
                                    variant="secondary"
                                  />
                                </Show>
                              </div>
                              <Button
                                class="game-scripts-dialog__package-remove-button"
                                disabled={busy()}
                                onClick={() => removePackage(valid)}
                                size="sm"
                                variant="destructive-outline"
                              >
                                Remove package
                              </Button>
                            </div>
                          </>
                        );
                      }}
                    </Show>
                  </section>
                )}
              </Show>

              <Show when={packageManagementView() === "installed"}>
                <Show
                  when={catalog().revision !== "" || !catalogLoading()}
                  fallback={
                    <div
                      class="game-scripts-dialog__empty game-scripts-dialog__loading"
                      role="status"
                    >
                      <Spinner size="sm" />
                      <span>Loading packages...</span>
                    </div>
                  }
                >
                  <Show
                    when={catalog().packages.length > 0}
                    fallback={
                      <div class="game-scripts-dialog__empty game-scripts-dialog__collection-empty">
                        <p class="game-scripts-dialog__collection-empty-title">
                          No packages installed
                        </p>
                        <p class="game-scripts-dialog__collection-empty-description">
                          Install a script package from a GitHub repository to
                          get started.
                        </p>
                      </div>
                    }
                  >
                    <div
                      ref={mountPackageViewport}
                      class="game-scripts-dialog__package-list"
                      onScroll={(event) => {
                        if (activeTab() === "packages") {
                          scrollPositions.packages =
                            event.currentTarget.scrollTop;
                        }
                      }}
                    >
                      <For each={catalog().packages}>
                        {(entry) => (
                          <Show
                            when={entry.status === "valid" ? entry : undefined}
                            keyed
                            fallback={
                              <button
                                aria-label={`View ${entry.name ?? "invalid package"} details`}
                                class="game-scripts-dialog__package-row"
                                onClick={() => openPackageDetails(entry)}
                                type="button"
                              >
                                <span class="game-scripts-dialog__package-copy">
                                  <span class="game-scripts-dialog__package-title">
                                    <span class="game-scripts-dialog__package-name">
                                      {entry.name ?? "Invalid package"}
                                    </span>
                                  </span>
                                  <span
                                    class="game-scripts-dialog__package-description"
                                    title={
                                      entry.status === "invalid"
                                        ? entry.diagnostic
                                        : undefined
                                    }
                                  >
                                    {entry.status === "invalid"
                                      ? entry.diagnostic
                                      : "This folder isn't a valid package."}
                                  </span>
                                </span>
                                <span
                                  class="game-scripts-dialog__package-row-tail"
                                  data-tone="error"
                                >
                                  <span>Needs attention</span>
                                  <Icon icon="chevron_right" size="sm" />
                                </span>
                              </button>
                            }
                          >
                            {(valid) => {
                              const displayStatus = createMemo(() =>
                                packageDisplayStatus(valid, rateLimitNow()),
                              );
                              return (
                                <button
                                  aria-label={`View ${valid.name} package details`}
                                  class="game-scripts-dialog__package-row"
                                  onClick={() => openPackageDetails(valid)}
                                  type="button"
                                >
                                  <span class="game-scripts-dialog__package-copy">
                                    <span class="game-scripts-dialog__package-title">
                                      <span class="game-scripts-dialog__package-name">
                                        {valid.name}
                                      </span>
                                      <Show when={valid.version} keyed>
                                        {(version) => (
                                          <span class="game-scripts-dialog__package-version">
                                            v{version}
                                          </span>
                                        )}
                                      </Show>
                                    </span>
                                    <span
                                      class="game-scripts-dialog__package-description"
                                      title={
                                        valid.description ??
                                        displayStatus().description
                                      }
                                    >
                                      {valid.description ??
                                        displayStatus().description}
                                    </span>
                                  </span>
                                  <span
                                    class="game-scripts-dialog__package-row-tail"
                                    data-tone={displayStatus().tone}
                                  >
                                    <span>{displayStatus().listLabel}</span>
                                    <Icon icon="chevron_right" size="sm" />
                                  </span>
                                </button>
                              );
                            }}
                          </Show>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Show>
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
      <Dialog
        initialFocusEl={packageTaskInitialFocusElement}
        open={packageTaskOpen()}
        onOpenChange={(details) => {
          if (!details.open) closePackageTask();
        }}
      >
        <DialogContent
          class="game-scripts-dialog__package-task-dialog"
          closeProps={{ disabled: busy() }}
        >
          <DialogHeader class="game-scripts-dialog__package-task-header">
            <DialogTitle
              ref={(element) => {
                packageTaskTitle = element;
              }}
              tabIndex={-1}
            >
              {packageTaskTitleText()}
            </DialogTitle>
            <DialogDescription>{packageTaskDescription()}</DialogDescription>
          </DialogHeader>

          <Show when={error() !== "" && confirmation() === null}>
            <ErrorAlert
              class="game-scripts-dialog__package-task-error"
              message={error()}
            />
          </Show>

          <Show when={packageTask().view === "install"}>
            <form
              class="game-scripts-dialog__package-task-form"
              novalidate
              onSubmit={(event) => {
                event.preventDefault();
                void beginInstall();
              }}
            >
              <DialogPanel class="game-scripts-dialog__package-task-panel game-scripts-dialog__install-fields">
                <Field
                  class="game-scripts-dialog__install-repository"
                  contentClass="game-scripts-dialog__repository-field"
                  error={repositoryFieldInvalid()}
                  for="script-package-repository"
                  label="GitHub repository"
                >
                  <Input
                    ref={(element) => {
                      repositoryInputElement = element;
                    }}
                    aria-describedby={
                      repositoryInput().kind === "repository"
                        ? undefined
                        : "script-package-repository-feedback"
                    }
                    fullWidth
                    id="script-package-repository"
                    invalid={repositoryFieldInvalid()}
                    name="repository-url"
                    required
                    spellcheck={false}
                    type="url"
                    placeholder="https://github.com/owner/repository"
                    value={repositoryUrl()}
                    onInput={(event) => {
                      setRepositoryUrl(event.currentTarget.value);
                      setRepositoryValidationAttempted(false);
                      setError("");
                    }}
                  />
                  <Show when={repositoryInput().kind !== "repository"}>
                    <div
                      class="game-scripts-dialog__repository-feedback"
                      data-invalid={repositoryFieldInvalid() ? "" : undefined}
                      id="script-package-repository-feedback"
                    >
                      <Show
                        when={repositorySuggestion()}
                        fallback={
                          repositoryUrl().trim() === ""
                            ? repositoryValidationAttempted()
                              ? "Enter a GitHub repository URL."
                              : "Enter the repository's GitHub URL."
                            : "Enter an https://github.com/owner/repository URL."
                        }
                      >
                        {(suggestion) => (
                          <>
                            <span>
                              Did you mean {suggestion().repository.owner}/
                              {suggestion().repository.repository} at ref{" "}
                              {suggestion().ref}?
                            </span>
                            <Button
                              onClick={applyRepositorySuggestion}
                              size="xs"
                              type="button"
                              variant="link"
                            >
                              Use suggestion
                            </Button>
                          </>
                        )}
                      </Show>
                    </div>
                  </Show>
                </Field>

                <Field
                  class="game-scripts-dialog__install-credential"
                  contentClass="game-scripts-dialog__credential-field"
                  for="script-package-credential"
                  label="GitHub token"
                >
                  <Select
                    class="game-scripts-dialog__credential-select"
                    ids={{ trigger: "script-package-credential" }}
                    positioning={{
                      fitViewport: true,
                      gutter: 4,
                      placement: "bottom-start",
                      sameWidth: true,
                    }}
                    value={[
                      credentialId() === "" ? "no-token" : credentialId(),
                    ]}
                    onValueChange={(details) => {
                      const value = details.value[0];
                      if (value === undefined) return;
                      setCredentialId(value === "no-token" ? "" : value);
                      setError("");
                    }}
                  >
                    <SelectTrigger class="game-scripts-dialog__credential-menu-trigger select__trigger select__trigger--sm">
                      <span
                        class="select__value"
                        title={selectedCredential()?.label}
                      >
                        {selectedCredential()?.label ?? "No token"}
                      </span>
                    </SelectTrigger>
                    <SelectContent class="game-scripts-dialog__credential-select-content">
                      <SelectItem
                        class="game-scripts-dialog__credential-option"
                        label="No token"
                        value="no-token"
                      >
                        <span class="game-scripts-dialog__credential-option-copy">
                          <span class="game-scripts-dialog__credential-option-label">
                            No token
                          </span>
                        </span>
                      </SelectItem>
                      <For each={credentials()}>
                        {(credential) => (
                          <SelectItem
                            class="game-scripts-dialog__credential-option"
                            label={credential.label}
                            title={credential.label}
                            value={credential.id}
                          >
                            <span class="game-scripts-dialog__credential-option-label">
                              {credential.label}
                            </span>
                          </SelectItem>
                        )}
                      </For>
                    </SelectContent>
                  </Select>
                  <div class="game-scripts-dialog__credential-field-footer">
                    <span>{GITHUB_TOKEN_USE_HINT}</span>
                    <Button
                      onClick={() => openCredentialEditor(undefined, "install")}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      <Icon aria-hidden="true" icon="plus" size="xs" />
                      Add GitHub token
                    </Button>
                  </div>
                </Field>

                <Button
                  aria-controls="script-package-install-options"
                  aria-expanded={installOptionsOpen()}
                  class="game-scripts-dialog__install-options-toggle"
                  onClick={() => setInstallOptionsOpen((current) => !current)}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  <Icon
                    aria-hidden="true"
                    class={
                      installOptionsOpen()
                        ? "game-scripts-dialog__install-options-icon game-scripts-dialog__install-options-icon--open"
                        : "game-scripts-dialog__install-options-icon"
                    }
                    icon="chevron_right"
                    size="xs"
                  />
                  <span>Advanced options</span>
                  <span class="game-scripts-dialog__install-options-optional">
                    Optional
                  </span>
                </Button>

                <Show when={installOptionsOpen()}>
                  <div
                    class="game-scripts-dialog__install-options"
                    id="script-package-install-options"
                  >
                    <p
                      class="game-scripts-dialog__install-options-hint"
                      id={INSTALL_ADVANCED_OPTIONS_HINT_ID}
                    >
                      Leave both blank to use the repository root and default
                      branch.
                    </p>
                    <Field
                      class="game-scripts-dialog__install-directory"
                      contentClass="game-scripts-dialog__install-directory-field"
                      error={packageDirectoryInvalid()}
                      for="script-package-directory"
                      label="Package directory"
                    >
                      <Input
                        ref={(element) => {
                          packageDirectoryInput = element;
                        }}
                        aria-describedby={`${INSTALL_ADVANCED_OPTIONS_HINT_ID} script-package-directory-feedback`}
                        fullWidth
                        id="script-package-directory"
                        invalid={packageDirectoryInvalid()}
                        name="package-directory"
                        placeholder="script-packages/package-name"
                        spellcheck={false}
                        value={packageDirectory()}
                        onInput={(event) => {
                          setPackageDirectory(event.currentTarget.value);
                          setPackageDirectoryInvalid(false);
                          setError("");
                        }}
                      />
                      <div
                        class="game-scripts-dialog__install-field-feedback"
                        data-invalid={
                          packageDirectoryInvalid() ? "" : undefined
                        }
                        id="script-package-directory-feedback"
                      >
                        {packageDirectoryInvalid()
                          ? "Use a repository-relative path with forward slashes and no . or .. segments."
                          : "Folder containing package.json, relative to the repository root."}
                      </div>
                    </Field>
                    <Field
                      class="game-scripts-dialog__install-ref"
                      for="script-package-ref"
                      label="Git ref"
                    >
                      <Input
                        aria-describedby={INSTALL_ADVANCED_OPTIONS_HINT_ID}
                        fullWidth
                        id="script-package-ref"
                        name="repository-ref"
                        placeholder="Branch, tag, or commit"
                        spellcheck={false}
                        value={repositoryRef()}
                        onInput={(event) => {
                          setRepositoryRef(event.currentTarget.value);
                          setError("");
                        }}
                      />
                    </Field>
                  </div>
                </Show>
              </DialogPanel>

              <DialogFooter>
                <Button
                  disabled={busy()}
                  onClick={closePackageTask}
                  type="button"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  disabled={installRateLimit() !== undefined}
                  loading={busy()}
                  title={packageRateLimitTitle(installRateLimit())}
                  type="submit"
                >
                  <Show when={installRateLimit()} fallback="Install package">
                    {(limit) =>
                      formatScriptPackageRetryLabel(
                        limit().retryAtTimestamp,
                        rateLimitNow(),
                      )
                    }
                  </Show>
                </Button>
              </DialogFooter>
            </form>
          </Show>

          <Show when={packageTask().view === "tokens"}>
            <DialogPanel class="game-scripts-dialog__package-task-panel game-scripts-dialog__credential-manager-body">
              <Show
                when={credentials().length > 0}
                fallback={
                  <div class="game-scripts-dialog__credential-manager-empty">
                    <Icon aria-hidden="true" icon="key_round" size="md" />
                    <div>
                      <strong>No GitHub tokens</strong>
                      <span>
                        Add one for private repositories or higher GitHub API
                        rate limits.
                      </span>
                    </div>
                  </div>
                }
              >
                <div class="game-scripts-dialog__credential-manager-list">
                  <For each={credentials()}>
                    {(credential) => (
                      <div class="game-scripts-dialog__credential-manager-row">
                        <div class="game-scripts-dialog__credential-manager-copy">
                          <span
                            class="game-scripts-dialog__credential-manager-label"
                            title={credential.label}
                          >
                            {credential.label}
                          </span>
                        </div>
                        <Menu
                          positioning={{
                            gutter: 4,
                            placement: "bottom-end",
                          }}
                        >
                          <MenuTrigger
                            asChild={(triggerProps) => (
                              <IconButton
                                {...(triggerProps({
                                  "aria-label": `More actions for ${credential.label}`,
                                  children: <Icon icon="ellipsis" size="sm" />,
                                  disabled: busy(),
                                  size: "icon-sm",
                                  type: "button",
                                  variant: "ghost",
                                } as IconButtonProps) as IconButtonProps)}
                              />
                            )}
                          />
                          <MenuContent>
                            <MenuItem
                              onSelect={() =>
                                queueMicrotask(() =>
                                  openCredentialEditor(credential),
                                )
                              }
                              value="replace-token"
                            >
                              Replace token
                            </MenuItem>
                            <MenuSeparator />
                            <MenuItem
                              onSelect={() =>
                                queueMicrotask(() =>
                                  deleteCredential(credential),
                                )
                              }
                              value="delete-token"
                              variant="destructive"
                            >
                              Delete token
                            </MenuItem>
                          </MenuContent>
                        </Menu>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </DialogPanel>

            <DialogFooter class="game-scripts-dialog__token-manager-actions">
              <Button
                ref={(element) => {
                  manageTokensAddButton = element;
                }}
                class="game-scripts-dialog__token-manager-add"
                disabled={busy()}
                onClick={() => openCredentialEditor()}
                type="button"
              >
                <Icon icon="plus" size="sm" />
                Add token
              </Button>
              <Button
                disabled={busy()}
                onClick={closePackageTask}
                type="button"
                variant="outline"
              >
                Done
              </Button>
            </DialogFooter>
          </Show>

          <Show when={packageTask().view === "token-editor"}>
            <form
              class="game-scripts-dialog__package-task-form"
              novalidate
              onSubmit={(event) => {
                event.preventDefault();
                void saveCredential();
              }}
            >
              <DialogPanel class="game-scripts-dialog__package-task-panel game-scripts-dialog__credential-editor-body">
                <Show when={editingCredentialId() === ""}>
                  <Field
                    class="game-scripts-dialog__credential-editor-form-field"
                    contentClass="game-scripts-dialog__credential-field"
                    error={credentialFormErrors().label !== undefined}
                    for="script-package-credential-label"
                    label="Name"
                  >
                    <Input
                      ref={(element) => {
                        credentialLabelInput = element;
                      }}
                      aria-describedby={GITHUB_TOKEN_LABEL_FEEDBACK_ID}
                      fullWidth
                      id="script-package-credential-label"
                      invalid={credentialFormErrors().label !== undefined}
                      name="token-label"
                      placeholder="Personal GitHub"
                      required
                      size="lg"
                      value={credentialLabel()}
                      onInput={(event) => {
                        setCredentialLabel(event.currentTarget.value);
                        setCredentialFormErrors((current) => {
                          const next = { ...current };
                          delete next.label;
                          return next;
                        });
                        setError("");
                      }}
                    />
                    <div
                      class="game-scripts-dialog__credential-field-feedback"
                      data-invalid={
                        credentialFormErrors().label === undefined
                          ? undefined
                          : ""
                      }
                      id={GITHUB_TOKEN_LABEL_FEEDBACK_ID}
                    >
                      {credentialFormErrors().label ??
                        "Choose a name you'll recognize."}
                    </div>
                  </Field>
                </Show>
                <Field
                  class="game-scripts-dialog__credential-editor-form-field"
                  contentClass="game-scripts-dialog__credential-field"
                  error={credentialFormErrors().token !== undefined}
                  for="script-package-credential-token"
                  label={
                    editingCredentialId() === ""
                      ? "Personal access token"
                      : "New personal access token"
                  }
                >
                  <InputGroup
                    class="game-scripts-dialog__credential-token-control"
                    size="lg"
                  >
                    <InputGroupInput
                      ref={(element) => {
                        credentialTokenInput = element;
                      }}
                      aria-describedby={GITHUB_TOKEN_VALUE_FEEDBACK_ID}
                      autocomplete="off"
                      id="script-package-credential-token"
                      invalid={credentialFormErrors().token !== undefined}
                      name="github-token"
                      required
                      spellcheck={false}
                      type={credentialTokenVisible() ? "text" : "password"}
                      value={credentialToken()}
                      onInput={(event) => {
                        setCredentialToken(event.currentTarget.value);
                        setCredentialFormErrors((current) => {
                          const next = { ...current };
                          delete next.token;
                          return next;
                        });
                        setError("");
                      }}
                    />
                    <InputGroupAddon
                      align="inline-end"
                      class="game-scripts-dialog__credential-token-addon"
                    >
                      <Tooltip closeDelay={0} openDelay={200}>
                        <TooltipTrigger
                          asChild={(triggerProps) => (
                            <Button
                              {...(triggerProps({
                                "aria-label": credentialTokenVisible()
                                  ? "Hide personal access token"
                                  : "Show personal access token",
                                "aria-pressed": credentialTokenVisible(),
                                class:
                                  "game-scripts-dialog__credential-token-visibility",
                                onClick: () =>
                                  setCredentialTokenVisible(
                                    (visible) => !visible,
                                  ),
                                size: "sm",
                                type: "button",
                                variant: "ghost",
                              } as ButtonProps) as ButtonProps)}
                            >
                              <Icon
                                icon={
                                  credentialTokenVisible() ? "eye_off" : "eye"
                                }
                              />
                            </Button>
                          )}
                        />
                        <TooltipContent>
                          {credentialTokenVisible()
                            ? "Hide personal access token"
                            : "Show personal access token"}
                        </TooltipContent>
                      </Tooltip>
                    </InputGroupAddon>
                  </InputGroup>
                  <div class="game-scripts-dialog__credential-token-help">
                    <span
                      class="game-scripts-dialog__credential-field-feedback"
                      data-invalid={
                        credentialFormErrors().token === undefined
                          ? undefined
                          : ""
                      }
                      id={GITHUB_TOKEN_VALUE_FEEDBACK_ID}
                    >
                      {credentialFormErrors().token ??
                        "Use read-only access to repository contents."}
                    </span>
                    <Button
                      as="a"
                      href={GITHUB_TOKEN_URL}
                      rel="noopener noreferrer"
                      size="xs"
                      target="_blank"
                      variant="link"
                    >
                      Create token on GitHub
                      <Icon
                        aria-hidden="true"
                        class="game-scripts-dialog__external-link-icon"
                        icon="arrow_up_right"
                        size="xs"
                      />
                    </Button>
                  </div>
                </Field>
              </DialogPanel>

              <DialogFooter>
                <Button
                  disabled={busy()}
                  onClick={closeCredentialEditor}
                  type="button"
                  variant="outline"
                >
                  Back
                </Button>
                <Button loading={busy()} type="submit">
                  {editingCredentialId() === ""
                    ? "Save token"
                    : "Replace token"}
                </Button>
              </DialogFooter>
            </form>
          </Show>
        </DialogContent>

        <Show when={packageTaskOpen()}>
          <ScriptsConfirmationDialog
            busy={busy()}
            error={error()}
            onClose={closeConfirmation}
            onConfirm={() => void runConfirmation()}
            pending={confirmation()}
          />
        </Show>
      </Dialog>

      <Show when={!packageTaskOpen()}>
        <ScriptsConfirmationDialog
          busy={busy()}
          error={error()}
          onClose={closeConfirmation}
          onConfirm={() => void runConfirmation()}
          pending={confirmation()}
        />
      </Show>
    </Dialog>
  );
}

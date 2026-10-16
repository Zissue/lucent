import { createHotkey, matchesKeyboardEvent } from "@tanstack/solid-hotkeys";
import {
  formatHotkeyDisplay,
  formatHotkeyDisplayParts,
} from "@lucent/core/hotkeys";
import {
  Icon,
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  type ButtonProps,
  Card,
  CardFrame,
  Checkbox,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  type ComboboxInputProps,
  ComboboxItem,
  ComboboxList,
  ContextMenuItem,
  ContextMenuSeparator,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  type InputGroupInputProps,
  Kbd,
  KbdGroup,
  Label,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Spinner,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@lucent/ui";
import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import {
  type AccountGameServer,
  type AccountGameServerPing,
  type AccountGameSession,
  type AccountManagerState,
  type AccountScriptReference,
  type ManagedAccount,
  type ManagedAccountGroups,
  type ManagedAccountDraft,
} from "@lucent/core/accounts";
import { ACCOUNT_SERVER_REFRESH_COOLDOWN_MS } from "../../../shared/accountPolicy";
import {
  selectDesktopBridge,
  type AppPlatform,
  type DesktopAccountsBridge,
} from "../../../shared/desktopBridge";
import type { DesktopRendererProps } from "../../RendererBootstrap";
import type { ScriptSelectFileResult } from "../../../shared/ipc/scripting";
import {
  readStoredAccountLoginServerPreference,
  resolveAccountLoginServerPreference,
  writeStoredAccountLoginServerPreference,
} from "./loginServerPreference";
import {
  readStoredAccountLaunchInNewWindow,
  readStoredAccountLaunchMode,
  writeStoredAccountLaunchInNewWindow,
  writeStoredAccountLaunchMode,
} from "./launchModePreference";
import {
  type AccountLaunchMode,
  resolveAccountLaunchWindowTarget,
} from "./launchMode";
import {
  haveSameAccountUsernames,
  resolveSelectedAccountUsernames,
} from "./accountSelection";
import {
  type ActiveWindowSessionGroup,
  groupActiveWindowSessions,
} from "./activeWindowSessionGroups";

interface AccountFormState {
  readonly label: string;
  readonly username: string;
  readonly password: string;
}

interface AccountFormErrors {
  readonly password?: string;
  readonly username?: string;
}

interface SaveOptions {
  readonly closeAfterSave: boolean;
}

interface LaunchCapacityWarning {
  readonly label: "Nearly full" | "Not enough slots";
  readonly message: string;
}

interface GroupFormState {
  readonly name: string;
  readonly usernames: ReadonlySet<string>;
}

interface GroupMemberEditState {
  readonly launchSearchQuery: string;
  readonly launchUsernames: ReadonlySet<string>;
  readonly mode: "create" | "update";
  readonly name: string;
  readonly originalName: string;
  readonly originalUsernames: ReadonlySet<string>;
}

type GroupMemberEditExitRequest =
  | { readonly type: "cancel" }
  | { readonly tab: AccountManagerTab; readonly type: "tab" };

export type AccountManagerTab = "launch" | "sessions";

type SessionCloseRequest =
  | { readonly type: "all" }
  | {
      readonly session: AccountGameSession;
      readonly type: "single";
    };

export interface AccountManagerViewFixture {
  readonly activeTab?: AccountManagerTab;
  readonly dialog?: {
    readonly account?: ManagedAccount;
    readonly error?: string;
    readonly mode: "create" | "edit";
  };
  readonly groupDeleteDialog?: {
    readonly error?: string;
    readonly name: string;
  };
  readonly groupDialog?: {
    readonly error?: string;
    readonly name: string;
  };
  readonly initialLoadingVisible?: boolean;
  readonly launchScript?: AccountScriptReference | null;
  readonly launchServer?: string;
  readonly useGameTabs?: boolean;
  readonly scriptError?: string;
  readonly searchQuery?: string;
  readonly selectedAccountUsernames?: readonly string[];
  readonly serverComboboxOpen?: boolean;
  readonly serverError?: string;
  readonly serverPings?: readonly AccountGameServerPing[];
  readonly serverPingsLoading?: boolean;
  readonly servers?: readonly AccountGameServer[];
  readonly serversLoading?: boolean;
  readonly state: AccountManagerState;
  readonly stateLoaded?: boolean;
}

export type AccountManagerViewCallbacks = Partial<DesktopAccountsBridge> & {
  readonly onUseGameTabsChanged?: (
    listener: (enabled: boolean) => void,
  ) => () => void;
  readonly selectScript?: () => Promise<ScriptSelectFileResult>;
};

export interface AccountManagerViewProps {
  readonly callbacks?: AccountManagerViewCallbacks;
  readonly fixture: AccountManagerViewFixture;
  readonly platform: AppPlatform;
}

const NO_SERVER_VALUE = "__no_server__";
const ACCOUNT_USERNAME_INPUT_ID = "account-manager-account-username";
const ACCOUNT_PASSWORD_INPUT_ID = "account-manager-account-password";
const ACCOUNT_USERNAME_ERROR_ID = "account-manager-account-username-error";
const ACCOUNT_PASSWORD_ERROR_ID = "account-manager-account-password-error";
const GROUP_NAME_ERROR_ID = "account-manager-group-name-error";
const GROUP_MEMBER_NAME_ERROR_ID = "account-manager-new-group-name-error";
const SCRIPT_ERROR_ID = "account-manager-script-error";
const SERVER_CAPACITY_WARNING_MIN_SPARE_SLOTS = 2;
const ACTION_TOOLTIP_OPEN_DELAY_MS = 200;
const FIELD_TOOLTIP_OPEN_DELAY_MS = 400;
const INTERACTIVE_TOOLTIP_CLOSE_DELAY_MS = 100;
const INITIAL_LOADING_INDICATOR_DELAY_MS = 150;
const SEARCH_ACCOUNTS_HOTKEY = "/";
const SAVED_GROUPS_HOTKEY = "G";
const NEW_ACCOUNT_HOTKEY = "Mod+N";
const LOGIN_SERVER_HOTKEY = "Mod+L";
const SELECT_SCRIPT_HOTKEY = "Mod+O";
const START_SELECTED_HOTKEY = "Mod+Enter";
const LAUNCH_TAB_HOTKEY = "Mod+1";
const SESSIONS_TAB_HOTKEY = "Mod+2";
const SAVED_GROUPS_TRIGGER_ID = "account-manager-saved-groups-trigger";
const START_OPTIONS_TRIGGER_ID = "account-manager-start-options-trigger";
const SESSION_TABLE_HEADER_IDS = {
  account: "account-manager-session-account-header",
  actions: "account-manager-session-actions-header",
  script: "account-manager-session-script-header",
  status: "account-manager-session-status-header",
} as const;

const sessionGroupHeaderId = (group: ActiveWindowSessionGroup): string =>
  `account-manager-session-group-${group.key.replace(":", "-")}`;

const sessionCellHeaders = (
  columnHeaderId: string,
  group: ActiveWindowSessionGroup,
): string =>
  group.shared
    ? `${columnHeaderId} ${sessionGroupHeaderId(group)}`
    : columnHeaderId;

const accountManagerTabTriggerId = (value: string): string =>
  `account-manager-tab-${value}`;

const hasOpenAlertDialog = (): boolean =>
  document.querySelector("[data-slot='alert-dialog-content']") !== null;

const isEditableHotkeyTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) {
    return false;
  }

  const editable = target.closest("input, textarea, select, [contenteditable]");
  return (
    editable !== null && editable.getAttribute("contenteditable") !== "false"
  );
};

const emptyState: AccountManagerState = {
  accounts: [],
  groups: {},
  sessions: [],
  storagePath: "",
};

const emptyForm = (): AccountFormState => ({
  label: "",
  username: "",
  password: "",
});

const emptyGroupForm = (): GroupFormState => ({
  name: "",
  usernames: new Set(),
});

const toDraft = (form: AccountFormState): ManagedAccountDraft => ({
  label: form.label.trim() === "" ? form.username : form.label,
  username: form.username,
  password: form.password,
});

const toForm = (account: ManagedAccount): AccountFormState => ({
  label: account.label,
  username: account.username,
  password: account.password,
});

type ServerAvailability = "full" | "offline" | "online";
type ServerPingQuality =
  | "good"
  | "pending"
  | "poor"
  | "unavailable"
  | "warning";

interface ServerPingDisplayState {
  readonly label: string;
  readonly quality: ServerPingQuality;
}

const serverAvailability = (server: AccountGameServer): ServerAvailability => {
  if (!server.online) {
    return "offline";
  }

  return server.playerCount >= server.maxPlayers ? "full" : "online";
};

const serverMeta = (server: AccountGameServer): string =>
  `(${server.playerCount}/${server.maxPlayers})`;

const serverDisplayLabel = (
  server: AccountGameServer | undefined,
  fallbackName: string,
): string =>
  server === undefined ? fallbackName : `${server.name} ${serverMeta(server)}`;

const serverPingLabel = (
  server: AccountGameServer,
  ping: AccountGameServerPing | undefined,
  loading: boolean,
): string => {
  if (!server.online) {
    return "";
  }

  if (ping === undefined) {
    return loading ? "ping..." : "n/a";
  }

  switch (ping.status) {
    case "ok":
      return `${ping.latencyMs} ms`;
    case "timeout":
      return "timeout";
    case "offline":
      return "";
    case "unreachable":
      return "n/a";
  }
};

const serverPingQuality = (
  server: AccountGameServer,
  ping: AccountGameServerPing | undefined,
  loading: boolean,
): ServerPingQuality => {
  if (!server.online) {
    return "unavailable";
  }

  if (ping === undefined) {
    return loading ? "pending" : "unavailable";
  }

  if (ping.status !== "ok") {
    return ping.status === "timeout" ? "poor" : "unavailable";
  }

  if (ping.latencyMs < 100) {
    return "good";
  }

  return ping.latencyMs < 200 ? "warning" : "poor";
};

const pluralize = (count: number, singular: string, plural = `${singular}s`) =>
  count === 1 ? singular : plural;

type ActiveWindowStatus = {
  readonly label: string;
  readonly variant: "outline" | "success" | "warning" | "error" | "secondary";
};

const activeWindowStatus = (
  session: AccountGameSession,
): ActiveWindowStatus => {
  switch (session.login.state) {
    case "failed":
      return { label: "Login failed", variant: "error" };
    case "waiting-for-game":
      return { label: "Waiting", variant: "warning" };
    case "authenticating":
      return { label: "Logging in", variant: "warning" };
    case "waiting-for-server":
      return { label: "Select server", variant: "warning" };
    case "selecting-server":
      return { label: "Connecting", variant: "warning" };
    case "waiting-for-player":
      return { label: "Loading player", variant: "warning" };
    case "idle":
      break;
  }

  if (session.connection.state === "offline") {
    return { label: "Offline", variant: "secondary" };
  }
  if (session.connection.state === "connecting") {
    return { label: "Connecting", variant: "warning" };
  }

  switch (session.script.state) {
    case "failed":
      return { label: "Failed", variant: "error" };
    case "running":
      return { label: "Running", variant: "success" };
    case "starting":
      return { label: "Starting", variant: "warning" };
    case "stopped":
      return session.script.name === undefined
        ? { label: "Online", variant: "success" }
        : { label: "Stopped", variant: "secondary" };
    case "idle":
      return session.script.name === undefined
        ? { label: "Online", variant: "success" }
        : { label: "Idle", variant: "outline" };
  }
};

const sameAccount = (previous: ManagedAccount, next: ManagedAccount): boolean =>
  previous.label === next.label &&
  previous.username === next.username &&
  previous.password === next.password;

const activeWindowAccountUsername = (
  session: AccountGameSession,
): string | undefined => {
  const username =
    session.connection.state === "online"
      ? session.connection.username
      : (session.connection.lastUsername ?? session.launch?.username);
  const normalized = username?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
};

const activeWindowScriptName = (
  session: AccountGameSession,
): string | undefined => session.script.name ?? session.launch?.scriptName;

const activeWindowDetailMessage = (
  session: AccountGameSession,
): string | undefined => {
  const message =
    ("message" in session.login ? session.login.message : undefined) ??
    ("message" in session.script ? session.script.message : undefined);
  const normalized = message?.trim();
  if (normalized === undefined || normalized === "") {
    return undefined;
  }

  const status = activeWindowStatus(session).label.toLowerCase();
  const scriptName = activeWindowScriptName(session)?.trim();
  const normalizedMessage = normalized.toLowerCase();

  if (normalizedMessage === status) {
    return undefined;
  }

  if (scriptName === undefined || scriptName === "") {
    return normalized;
  }

  const normalizedScriptName = scriptName.toLowerCase();
  if (
    normalizedMessage === normalizedScriptName ||
    normalizedMessage === `${status} ${normalizedScriptName}`
  ) {
    return undefined;
  }

  return normalized;
};

const confirmRemoveDescription = (label: string): string =>
  `Remove “${label}” and its saved login details?`;

const sameGroups = (
  previous: ManagedAccountGroups,
  next: ManagedAccountGroups,
): boolean => {
  const previousEntries = Object.entries(previous);
  const nextEntries = Object.entries(next);
  if (previousEntries.length !== nextEntries.length) {
    return false;
  }

  return previousEntries.every(([name, previousUsernames]) => {
    const nextUsernames = next[name];
    return (
      nextUsernames !== undefined &&
      previousUsernames.length === nextUsernames.length &&
      previousUsernames.every(
        (username, index) => username === nextUsernames[index],
      )
    );
  });
};

const reconcileAccounts = (
  previousAccounts: readonly ManagedAccount[],
  nextAccounts: readonly ManagedAccount[],
): readonly ManagedAccount[] => {
  const previousByUsername = new Map(
    previousAccounts.map((account) => [account.username, account]),
  );
  let changed = previousAccounts.length !== nextAccounts.length;
  const accounts = nextAccounts.map((account, index) => {
    const previous = previousByUsername.get(account.username);
    if (previous !== undefined && sameAccount(previous, account)) {
      changed ||= previousAccounts[index] !== previous;
      return previous;
    }

    changed = true;
    return account;
  });

  return changed ? accounts : previousAccounts;
};

const sessionIdentityKey = (session: AccountGameSession): string =>
  `window:${session.gameWindowId}`;

const reconcileSessions = (
  previousSessions: readonly AccountGameSession[],
  nextSessions: readonly AccountGameSession[],
): readonly AccountGameSession[] => {
  const previousByIdentity = new Map(
    previousSessions.map((session) => [sessionIdentityKey(session), session]),
  );
  let changed = previousSessions.length !== nextSessions.length;
  const sessions = nextSessions.map((session, index) => {
    const previous = previousByIdentity.get(sessionIdentityKey(session));
    if (
      previous !== undefined &&
      (previous.rendererGeneration > session.rendererGeneration ||
        (previous.rendererGeneration === session.rendererGeneration &&
          previous.revision > session.revision))
    ) {
      changed ||= previousSessions[index] !== previous;
      return previous;
    }

    if (
      previous !== undefined &&
      previous.rendererGeneration === session.rendererGeneration &&
      previous.revision === session.revision
    ) {
      changed ||= previousSessions[index] !== previous;
      return previous;
    }

    changed = true;
    return session;
  });

  return changed ? sessions : previousSessions;
};

const reconcileAccountManagerState = (
  previousState: AccountManagerState,
  nextState: AccountManagerState,
): AccountManagerState => {
  const accounts = reconcileAccounts(
    previousState.accounts,
    nextState.accounts,
  );
  const sessions = reconcileSessions(
    previousState.sessions,
    nextState.sessions,
  );
  const groups = sameGroups(previousState.groups, nextState.groups)
    ? previousState.groups
    : nextState.groups;

  if (
    previousState.storagePath === nextState.storagePath &&
    previousState.accounts === accounts &&
    previousState.groups === groups &&
    previousState.sessions === sessions
  ) {
    return previousState;
  }

  return {
    accounts,
    groups,
    sessions,
    storagePath: nextState.storagePath,
  };
};

function ShortcutKbd(props: {
  readonly label: string;
  readonly parts: readonly string[];
}): JSX.Element {
  return (
    <KbdGroup aria-label={props.label}>
      <For each={props.parts}>{(part) => <Kbd>{part}</Kbd>}</For>
    </KbdGroup>
  );
}

/** Shows a consistent detail tooltip only when its text is truncated. */
function OverflowText(props: {
  readonly as?: "span" | "strong";
  readonly class?: string;
  readonly text: string;
  readonly translate?: "yes" | "no";
}): JSX.Element {
  let textElement: HTMLElement | undefined;
  const [truncated, setTruncated] = createSignal(false);
  const measure = (): void => {
    setTruncated(
      textElement !== undefined &&
        (textElement.scrollWidth > textElement.clientWidth ||
          textElement.scrollHeight > textElement.clientHeight),
    );
  };
  const elementProps = {
    class: props.class,
    ref: (element: HTMLElement) => {
      textElement = element;
    },
    translate: props.translate,
  } satisfies JSX.HTMLAttributes<HTMLElement>;

  createEffect(() => {
    if (props.text.length === 0) {
      setTruncated(false);
      return;
    }
    queueMicrotask(measure);
  });

  onMount(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (textElement !== undefined) {
      observer.observe(textElement);
    }
    onCleanup(() => observer.disconnect());
  });

  return (
    <Tooltip
      closeDelay={0}
      openDelay={FIELD_TOOLTIP_OPEN_DELAY_MS}
      unmountOnExit
    >
      <TooltipTrigger
        asChild={(triggerProps) =>
          props.as === "strong" ? (
            <strong {...triggerProps(elementProps)}>{props.text}</strong>
          ) : (
            <span {...triggerProps(elementProps)}>{props.text}</span>
          )
        }
      />
      <Show when={truncated()}>
        <TooltipContent>{props.text}</TooltipContent>
      </Show>
    </Tooltip>
  );
}

/** Tracks the space consumed by a conditionally mounted vertical scrollbar. */
function createScrollbarGutterObserver(): {
  readonly gutterWidth: () => number;
  readonly ref: (element: HTMLElement) => void;
} {
  let target: HTMLElement | undefined;
  let measurementFrame: number | undefined;
  let mutationObserver: MutationObserver | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const [gutterWidth, setGutterWidth] = createSignal(0);
  const measure = (): void => {
    measurementFrame = undefined;
    setGutterWidth(
      target === undefined
        ? 0
        : Math.max(0, target.offsetWidth - target.clientWidth),
    );
  };
  const scheduleMeasure = (): void => {
    if (measurementFrame !== undefined) return;
    measurementFrame = window.requestAnimationFrame(measure);
  };
  const observeTarget = (): void => {
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    if (target === undefined) return;
    mutationObserver?.observe(target, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    resizeObserver?.observe(target);
    scheduleMeasure();
  };

  onMount(() => {
    mutationObserver = new MutationObserver(scheduleMeasure);
    resizeObserver = new ResizeObserver(scheduleMeasure);
    observeTarget();
    onCleanup(() => {
      if (measurementFrame !== undefined) {
        window.cancelAnimationFrame(measurementFrame);
      }
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
    });
  });

  return {
    gutterWidth,
    ref: (element) => {
      target = element;
      observeTarget();
    },
  };
}

/**
 * Composes tab and tooltip behavior onto one button while preserving the tab
 * trigger's DOM identity for focus navigation and panel relationships.
 */
function AccountManagerTabTrigger(props: {
  readonly children: JSX.Element;
  readonly keyshortcuts: string;
  readonly shortcutLabel: string;
  readonly shortcutParts: readonly string[];
  readonly tooltipLabel: string;
  readonly value: AccountManagerTab;
}): JSX.Element {
  return (
    <Tooltip
      closeDelay={0}
      ids={{ trigger: accountManagerTabTriggerId(props.value) }}
      openDelay={ACTION_TOOLTIP_OPEN_DELAY_MS}
    >
      <TabsTrigger
        asChild={(tabTriggerProps) => (
          <TooltipTrigger
            {...tabTriggerProps({
              "aria-keyshortcuts": props.keyshortcuts,
              children: props.children,
            })}
            value={props.value}
          />
        )}
        value={props.value}
      />
      <TooltipContent>
        {props.tooltipLabel}{" "}
        <ShortcutKbd label={props.shortcutLabel} parts={props.shortcutParts} />
      </TooltipContent>
    </Tooltip>
  );
}

function SavedGroupOption(props: {
  readonly memberLabels: readonly string[];
  readonly name: string;
}): JSX.Element {
  const memberCount = () => props.memberLabels.length;
  const optionLabel = () => {
    if (memberCount() === 0) {
      return `${props.name}, no accounts`;
    }

    return `${props.name}, ${memberCount()} ${pluralize(
      memberCount(),
      "account",
    )}: ${props.memberLabels.join(", ")}`;
  };

  return (
    <ComboboxItem
      aria-label={optionLabel()}
      label={props.name}
      value={props.name}
    >
      <Tooltip
        closeDelay={INTERACTIVE_TOOLTIP_CLOSE_DELAY_MS}
        closeOnScroll={false}
        interactive
        openDelay={FIELD_TOOLTIP_OPEN_DELAY_MS}
        positioning={{
          fitViewport: true,
          listeners: { animationFrame: true },
          overflowPadding: 8,
          placement: "right-start",
        }}
        unmountOnExit
      >
        <TooltipTrigger
          asChild={(triggerProps) => (
            <span
              {...triggerProps({
                class: "account-group-option",
              })}
            >
              <span class="account-group-option__name">{props.name}</span>
              <span
                aria-label={`${memberCount()} ${pluralize(
                  memberCount(),
                  "account",
                )}`}
                class="account-group-option__meta"
              >
                {memberCount()}
              </span>
            </span>
          )}
        />
        <TooltipContent class="account-manager__group-members-tooltip">
          <strong>
            {`${memberCount()} ${pluralize(memberCount(), "account")} in ${
              props.name
            }`}
          </strong>
          <Show
            when={memberCount() > 0}
            fallback={<span>No accounts in this group</span>}
          >
            <ul>
              <For each={props.memberLabels}>
                {(memberLabel) => <li>{memberLabel}</li>}
              </For>
            </ul>
          </Show>
        </TooltipContent>
      </Tooltip>
    </ComboboxItem>
  );
}

function AccountIdentity(props: {
  readonly account: ManagedAccount;
  readonly layout: "card" | "member";
}): JSX.Element {
  const showUsername = () => props.account.label !== props.account.username;

  return (
    <span
      class={`account-identity account-identity--${props.layout}`}
      data-has-username={showUsername() ? "" : undefined}
    >
      <OverflowText
        class="account-identity__label"
        text={props.account.label}
      />
      <Show when={showUsername()}>
        <OverflowText
          class="account-identity__username"
          text={props.account.username}
          translate="no"
        />
      </Show>
    </span>
  );
}

type AccountActionMenuKind = "context" | "dropdown";

function AccountActionMenuItem(props: {
  readonly children: JSX.Element;
  readonly menu: AccountActionMenuKind;
  readonly onSelect: () => void;
  readonly value: string;
  readonly variant?: "default" | "destructive";
}): JSX.Element {
  return props.menu === "context" ? (
    <ContextMenuItem
      onSelect={props.onSelect}
      value={props.value}
      variant={props.variant ?? "default"}
    >
      {props.children}
    </ContextMenuItem>
  ) : (
    <MenuItem
      onSelect={props.onSelect}
      value={props.value}
      variant={props.variant ?? "default"}
    >
      {props.children}
    </MenuItem>
  );
}

function AccountActionMenuSeparator(props: {
  readonly menu: AccountActionMenuKind;
}): JSX.Element {
  return props.menu === "context" ? (
    <ContextMenuSeparator />
  ) : (
    <MenuSeparator />
  );
}

function AccountActionMenuItems(props: {
  readonly menu: AccountActionMenuKind;
  readonly script: AccountScriptReference | null;
  readonly onDelete: () => void;
  readonly onEdit: () => void;
  readonly onLaunch: (script: AccountScriptReference | null) => void;
}): JSX.Element {
  return (
    <>
      <AccountActionMenuItem
        menu={props.menu}
        onSelect={() => props.onLaunch(props.script)}
        value="launch"
      >
        {props.script === null ? "Launch" : "Launch with script"}
      </AccountActionMenuItem>
      <Show when={props.script !== null}>
        <AccountActionMenuItem
          menu={props.menu}
          onSelect={() => props.onLaunch(null)}
          value="launch-without-script"
        >
          Launch without script
        </AccountActionMenuItem>
      </Show>
      <AccountActionMenuSeparator menu={props.menu} />
      <AccountActionMenuItem
        menu={props.menu}
        onSelect={() => queueMicrotask(props.onEdit)}
        value="edit"
      >
        Edit
      </AccountActionMenuItem>
      <AccountActionMenuSeparator menu={props.menu} />
      <AccountActionMenuItem
        menu={props.menu}
        onSelect={() => queueMicrotask(props.onDelete)}
        value="delete"
        variant="destructive"
      >
        Remove
      </AccountActionMenuItem>
    </>
  );
}

/** Keeps the action tooltip and menu anchored to one stable icon button. */
interface MoreActionsTriggerAttributes extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly "data-group-actions"?: string;
  readonly "data-group-name"?: string;
}

function MoreActionsTrigger(props: {
  readonly "aria-label": string;
  readonly disabled?: boolean | undefined;
  readonly menuOpen: boolean;
  readonly onContextMenu?: () => void;
  readonly onTriggerElement?: (element: HTMLButtonElement) => void;
  readonly tooltip: string;
  readonly tooltipDisabled?: boolean | undefined;
  readonly triggerId: string;
  readonly triggerAttributes?: MoreActionsTriggerAttributes | undefined;
}): JSX.Element {
  let triggerElement: HTMLButtonElement | undefined;
  const [tooltipOpen, setTooltipOpen] = createSignal(false);
  const [tooltipSuppressed, setTooltipSuppressed] = createSignal(false);
  const tooltipEnabled = (): boolean =>
    !props.disabled &&
    !props.tooltipDisabled &&
    !props.menuOpen &&
    !tooltipSuppressed();
  const getTriggerRect = (): DOMRect | null =>
    triggerElement?.getBoundingClientRect() ?? null;

  createEffect(() => {
    if (tooltipEnabled()) {
      return;
    }

    setTooltipOpen(false);
  });

  return (
    <Tooltip
      closeDelay={0}
      disabled={!tooltipEnabled()}
      ids={{ trigger: props.triggerId }}
      open={tooltipOpen() && tooltipEnabled()}
      openDelay={ACTION_TOOLTIP_OPEN_DELAY_MS}
      positioning={{
        fitViewport: true,
        getAnchorRect: getTriggerRect,
        listeners: { animationFrame: true },
        overflowPadding: 8,
        placement: "top",
      }}
      unmountOnExit
      onOpenChange={(details) => {
        setTooltipOpen(details.open && tooltipEnabled());
      }}
    >
      <MenuTrigger
        value="button"
        asChild={(menuTriggerProps) => (
          <TooltipTrigger
            asChild={(tooltipTriggerProps) => (
              <Button
                {...(tooltipTriggerProps(
                  menuTriggerProps({
                    ...props.triggerAttributes,
                    "aria-label": props["aria-label"],
                    disabled: props.disabled,
                    onContextMenu: (event) => {
                      // Keep a containing row handler from competing with this trigger.
                      event.preventDefault();
                      event.stopPropagation();
                      setTooltipSuppressed(true);
                      setTooltipOpen(false);
                      if (!props.disabled) {
                        props.onContextMenu?.();
                      }
                    },
                    onPointerLeave: () => setTooltipSuppressed(false),
                    ref: (element) => {
                      triggerElement = element;
                      props.onTriggerElement?.(element);
                    },
                    size: "icon-sm",
                    type: "button",
                    variant: "ghost",
                  } as ButtonProps),
                ) as ButtonProps)}
              >
                <Icon icon="ellipsis" class="button__icon" />
              </Button>
            )}
          />
        )}
      />
      <TooltipContent>{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function MoreActionsMenu(props: {
  readonly "aria-label": string;
  readonly anchorPoint?: { readonly x: number; readonly y: number } | null;
  readonly children: JSX.Element;
  readonly disabled?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onTriggerElement?: (element: HTMLButtonElement) => void;
  readonly tooltip: string;
  readonly tooltipDisabled?: boolean;
  readonly triggerAttributes?: MoreActionsTriggerAttributes;
}): JSX.Element {
  const triggerId = `more-actions-${createUniqueId()}`;
  let triggerElement: HTMLButtonElement | undefined;
  const [uncontrolledMenuOpen, setUncontrolledMenuOpen] = createSignal(false);
  const menuOpen = (): boolean => props.open ?? uncontrolledMenuOpen();
  const updateMenuOpen = (open: boolean): void => {
    setUncontrolledMenuOpen(open);
    props.onOpenChange?.(open);
  };

  createEffect(() => {
    if (!props.disabled) {
      return;
    }

    updateMenuOpen(false);
  });

  return (
    <Menu
      aria-label={props["aria-label"]}
      ids={{ trigger: triggerId }}
      open={menuOpen()}
      positioning={{
        fitViewport: true,
        getAnchorRect: () => {
          const anchorPoint = props.anchorPoint;
          return anchorPoint === null || anchorPoint === undefined
            ? (triggerElement?.getBoundingClientRect() ?? null)
            : {
                height: 0,
                width: 0,
                x: anchorPoint.x,
                y: anchorPoint.y,
              };
        },
        gutter: 4,
        hideWhenDetached: true,
        listeners: { animationFrame: true },
        overflowPadding: 8,
        placement: "bottom-end",
      }}
      unmountOnExit
      onOpenChange={(details) =>
        updateMenuOpen(details.open && !props.disabled)
      }
    >
      <MoreActionsTrigger
        aria-label={props["aria-label"]}
        disabled={props.disabled}
        menuOpen={menuOpen()}
        onContextMenu={() => updateMenuOpen(true)}
        onTriggerElement={(element) => {
          triggerElement = element;
          props.onTriggerElement?.(element);
        }}
        tooltip={props.tooltip}
        tooltipDisabled={props.tooltipDisabled}
        triggerAttributes={props.triggerAttributes}
        triggerId={triggerId}
      />
      <MenuContent>{props.children}</MenuContent>
    </Menu>
  );
}

/** Renders Account Manager from typed state and optional interaction callbacks. */
export function AccountManagerView(
  props: AccountManagerViewProps,
): JSX.Element {
  let accountSearchInput: HTMLInputElement | undefined;
  let groupNameInput: HTMLInputElement | undefined;
  let serverFieldElement: HTMLDivElement | undefined;
  let serverComboboxInput: HTMLInputElement | undefined;
  let replaceServerInputOnEdit = false;
  let groupComboboxInput: HTMLInputElement | undefined;
  let replaceGroupInputOnEdit = false;
  let groupComboboxTooltipReleaseFrame: number | undefined;
  let suppressAccountSearchTooltipFocus = false;
  let suppressGroupComboboxTooltipFocus = false;
  let accountDialogReturnFocus: HTMLElement | null = null;
  let accountDialogRestoreFrame: number | undefined;
  let usernameInput: HTMLInputElement | undefined;
  let passwordInput: HTMLInputElement | undefined;
  let groupDialogNameInput: HTMLInputElement | undefined;
  let serverSelectionSettlingTimeout: number | undefined;
  let serverPingRequestId = 0;
  const initialDialogAccount = props.fixture.dialog?.account;
  const initialGroupDialog = props.fixture.groupDialog;
  const [state, setState] = createSignal<AccountManagerState>(
    props.fixture.state,
  );
  const [stateLoaded, setStateLoaded] = createSignal(
    props.fixture.stateLoaded ?? true,
  );
  const [initialLoadingVisible, setInitialLoadingVisible] = createSignal(
    props.fixture.initialLoadingVisible ?? false,
  );
  const [selectedAccountUsernames, setSelectedAccountUsernames] = createSignal<
    ReadonlySet<string>
  >(new Set(props.fixture.selectedAccountUsernames ?? []));
  const [accountToDelete, setAccountToDelete] =
    createSignal<ManagedAccount | null>(null);
  const [sessionCloseRequest, setSessionCloseRequest] =
    createSignal<SessionCloseRequest | null>(null);
  const [sessionCloseDialogOpen, setSessionCloseDialogOpen] =
    createSignal(false);
  const [selectedGroupName, setSelectedGroupName] = createSignal("");
  const [groupComboboxOpen, setGroupComboboxOpen] = createSignal(false);
  const [groupComboboxInputValue, setGroupComboboxInputValue] =
    createSignal("");
  const [groupSearchQuery, setGroupSearchQuery] = createSignal("");
  const [groupComboboxTooltipOpen, setGroupComboboxTooltipOpen] =
    createSignal(false);
  const [groupManagerOpen, setGroupManagerOpen] = createSignal(false);
  const [groupManagerFocusTarget, setGroupManagerFocusTarget] = createSignal<
    string | null
  >(null);
  const [groupToDelete, setGroupToDelete] = createSignal<string | null>(
    props.fixture.groupDeleteDialog?.name ?? null,
  );
  const [groupDeleteError, setGroupDeleteError] = createSignal(
    props.fixture.groupDeleteDialog?.error ?? "",
  );
  const [groupDialogOpen, setGroupDialogOpen] = createSignal(
    initialGroupDialog !== undefined,
  );
  const [editingGroupName, setEditingGroupName] = createSignal<string | null>(
    initialGroupDialog?.name ?? null,
  );
  const [groupForm, setGroupForm] = createSignal<GroupFormState>(
    initialGroupDialog === undefined
      ? emptyGroupForm()
      : {
          name: initialGroupDialog.name,
          usernames: new Set(
            props.fixture.state.groups[initialGroupDialog.name] ?? [],
          ),
        },
  );
  const [groupDialogError, setGroupDialogError] = createSignal(
    initialGroupDialog?.error ?? "",
  );
  const [groupNameError, setGroupNameError] = createSignal("");
  const [groupMemberEdit, setGroupMemberEdit] =
    createSignal<GroupMemberEditState | null>(null);
  const [groupMemberEditError, setGroupMemberEditError] = createSignal("");
  const [groupMemberEditNameError, setGroupMemberEditNameError] =
    createSignal("");
  const [groupMemberEditExitRequest, setGroupMemberEditExitRequest] =
    createSignal<GroupMemberEditExitRequest | null>(null);
  const [form, setForm] = createSignal<AccountFormState>(
    initialDialogAccount === undefined
      ? emptyForm()
      : toForm(initialDialogAccount),
  );
  const [formErrors, setFormErrors] = createSignal<AccountFormErrors>({});
  const [passwordVisible, setPasswordVisible] = createSignal(false);
  const [dialogOpen, setDialogOpen] = createSignal(
    props.fixture.dialog !== undefined,
  );
  const [dialogMode, setDialogMode] = createSignal<"create" | "edit">(
    props.fixture.dialog?.mode ?? "create",
  );
  const [editingUsername, setEditingUsername] = createSignal<string | null>(
    initialDialogAccount?.username ?? null,
  );
  const [dialogError, setDialogError] = createSignal(
    props.fixture.dialog?.error ?? "",
  );
  const [searchQuery, setSearchQuery] = createSignal(
    props.fixture.searchQuery ?? "",
  );
  const [accountSearchTooltipOpen, setAccountSearchTooltipOpen] =
    createSignal(false);
  const [launchScript, setLaunchScript] =
    createSignal<AccountScriptReference | null>(
      props.fixture.launchScript ?? null,
    );
  const [scriptSelectionTooltipOpen, setScriptSelectionTooltipOpen] =
    createSignal(false);
  const [scriptError, setScriptError] = createSignal(
    props.fixture.scriptError ?? "",
  );
  const [launchServer, setLaunchServer] = createSignal(
    props.fixture.launchServer ?? "",
  );
  const [loginServerTooltipOpen, setLoginServerTooltipOpen] =
    createSignal(false);
  const [accountLaunchMode, setAccountLaunchMode] =
    createSignal<AccountLaunchMode>(readStoredAccountLaunchMode());
  const [launchInNewWindow, setLaunchInNewWindow] = createSignal(
    readStoredAccountLaunchInNewWindow(),
  );
  const [useGameTabs, setUseGameTabs] = createSignal(
    props.fixture.useGameTabs ?? false,
  );
  const [startOptionsOpen, setStartOptionsOpen] = createSignal(false);
  const [serverComboboxOpen, setServerComboboxOpen] = createSignal(
    props.fixture.serverComboboxOpen ?? false,
  );
  const [serverInputFocused, setServerInputFocused] = createSignal(false);
  const [serverInputValue, setServerInputValue] = createSignal(
    props.fixture.launchServer ?? "",
  );
  const [serverSearchQuery, setServerSearchQuery] = createSignal("");
  const [serverSelectionInitialized, setServerSelectionInitialized] =
    createSignal(props.fixture.servers !== undefined);
  const [servers, setServers] = createSignal<readonly AccountGameServer[]>(
    props.fixture.servers ?? [],
  );
  const [serversLoading, setServersLoading] = createSignal(
    props.fixture.serversLoading ?? false,
  );
  const [serverPingsLoading, setServerPingsLoading] = createSignal(
    props.fixture.serverPingsLoading ?? false,
  );
  const [serverPings, setServerPings] = createSignal<
    ReadonlyMap<string, AccountGameServerPing>
  >(
    new Map(
      (props.fixture.serverPings ?? []).map((ping) => [ping.serverName, ping]),
    ),
  );
  const [serverSelectionSettling, setServerSelectionSettling] =
    createSignal(false);
  const [serverError, setServerError] = createSignal(
    props.fixture.serverError ?? "",
  );
  const [serverRefreshCooldownUntil, setServerRefreshCooldownUntil] =
    createSignal(0);
  const [serverRefreshNow, setServerRefreshNow] = createSignal(Date.now());
  const [busy, setBusy] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<AccountManagerTab>(
    props.fixture.activeTab ?? "launch",
  );
  const [removeSelectedDialogOpen, setRemoveSelectedDialogOpen] =
    createSignal(false);
  const [closingGameWindowIds, setClosingGameWindowIds] = createSignal<
    ReadonlySet<number>
  >(new Set());
  const [bulkClosingGameWindows, setBulkClosingGameWindows] =
    createSignal(false);
  const sessionsTableScrollbar = createScrollbarGutterObserver();
  const isAccountSelected = createSelector(
    selectedAccountUsernames,
    (username: string, selected) => selected.has(username),
  );

  const updateGroupComboboxOpen = (open: boolean): void => {
    if (groupComboboxTooltipReleaseFrame !== undefined) {
      window.cancelAnimationFrame(groupComboboxTooltipReleaseFrame);
      groupComboboxTooltipReleaseFrame = undefined;
    }

    suppressGroupComboboxTooltipFocus = true;
    setGroupComboboxTooltipOpen(false);
    setGroupComboboxOpen(open);
    if (!open) {
      replaceGroupInputOnEdit = false;
      setGroupSearchQuery("");
      setGroupComboboxInputValue(selectedGroupName());
      // The combobox may restore input focus in the next frame. Release one
      // frame later so that restored focus does not reopen the tooltip.
      groupComboboxTooltipReleaseFrame = window.requestAnimationFrame(() => {
        groupComboboxTooltipReleaseFrame = window.requestAnimationFrame(() => {
          groupComboboxTooltipReleaseFrame = undefined;
          suppressGroupComboboxTooltipFocus = false;
        });
      });
    }
  };

  onCleanup(() => {
    if (groupComboboxTooltipReleaseFrame !== undefined) {
      window.cancelAnimationFrame(groupComboboxTooltipReleaseFrame);
    }
    if (accountDialogRestoreFrame !== undefined) {
      window.cancelAnimationFrame(accountDialogRestoreFrame);
    }
  });

  const accounts = createMemo(() => state().accounts);
  const accountUsernames = createMemo(
    () => new Set(accounts().map((account) => account.username)),
  );
  const accountsByUsername = createMemo(
    () =>
      new Map(
        accounts().map((account) => [account.username, account] as const),
      ),
  );
  const groups = createMemo(() => state().groups);
  const groupEntries = createMemo(() =>
    Object.entries(groups()).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const filteredGroupEntries = createMemo(() => {
    const query = groupSearchQuery().trim().toLowerCase();
    if (query === "") {
      return groupEntries();
    }

    return groupEntries().filter(([name]) =>
      name.toLowerCase().includes(query),
    );
  });
  const groupComboboxItems = createMemo(() =>
    filteredGroupEntries().map(([name]) => ({ label: name, value: name })),
  );
  createEffect(() => {
    const groupName = selectedGroupName();
    if (!groupComboboxOpen()) {
      setGroupComboboxInputValue(groupName);
    }
  });
  createEffect(() => {
    const groupName = selectedGroupName();
    if (groupName === "" || groupMemberEdit() !== null) {
      return;
    }

    const members = groups()[groupName];
    if (members === undefined) {
      setSelectedGroupName("");
      return;
    }

    const usernames = accountUsernames();
    const availableMembers = new Set(
      members.filter((username) => usernames.has(username)),
    );
    if (
      !haveSameAccountUsernames(availableMembers, selectedAccountUsernames())
    ) {
      setSelectedGroupName("");
    }
  });
  const filteredAccounts = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    if (query === "") {
      return accounts();
    }

    return accounts().filter((account) => {
      return (
        account.label.toLowerCase().includes(query) ||
        account.username.toLowerCase().includes(query)
      );
    });
  });
  const activeWindowSessions = createMemo(() =>
    state()
      .sessions.slice()
      .sort((left, right) => right.updatedAt - left.updatedAt),
  );
  const bulkCloseGameWindowsLabel = createMemo(() =>
    activeWindowSessions().length === 1
      ? "Close game session"
      : "Close all game sessions",
  );
  const bulkCloseGameWindowsShortLabel = createMemo(() =>
    activeWindowSessions().length === 1
      ? "Close session"
      : "Close all sessions",
  );
  createEffect(() => {
    if (!sessionCloseDialogOpen()) {
      return;
    }

    const request = sessionCloseRequest();
    const sessions = activeWindowSessions();
    const targetStillOpen =
      request?.type === "all"
        ? sessions.length > 0
        : request?.type === "single" &&
          sessions.some(
            (session) => session.gameWindowId === request.session.gameWindowId,
          );
    if (!targetStillOpen) {
      setSessionCloseDialogOpen(false);
    }
  });
  const activeWindowSessionGroups = createMemo(() =>
    groupActiveWindowSessions(activeWindowSessions()),
  );
  createEffect(() => {
    const activeGameWindowIds = new Set<number>();
    for (const session of activeWindowSessions()) {
      activeGameWindowIds.add(session.gameWindowId);
    }

    setClosingGameWindowIds((previous) => {
      let changed = false;
      const next = new Set<number>();
      for (const gameWindowId of previous) {
        if (activeGameWindowIds.has(gameWindowId)) {
          next.add(gameWindowId);
        } else {
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  });
  const selectedLaunchUsernames = createMemo(() => {
    return resolveSelectedAccountUsernames(
      accounts(),
      selectedAccountUsernames(),
    );
  });
  const selectedAccountCount = createMemo(
    () => selectedAccountUsernames().size,
  );
  const groupMemberEditDirty = createMemo(() => {
    const edit = groupMemberEdit();
    return (
      edit !== null &&
      (edit.name !== edit.originalName ||
        !haveSameAccountUsernames(
          selectedAccountUsernames(),
          edit.originalUsernames,
        ))
    );
  });
  const canStartSelected = createMemo(
    () => groupMemberEdit() === null && !busy() && selectedAccountCount() > 0,
  );
  const hasMultipleSelectedAccounts = createMemo(
    () => selectedAccountCount() > 1,
  );
  const canConfigureLaunchOptions = createMemo(
    () => groupMemberEdit() === null && !busy(),
  );
  const primaryAccountLaunchMode = createMemo<AccountLaunchMode>(() =>
    hasMultipleSelectedAccounts() && useGameTabs()
      ? accountLaunchMode()
      : "standard",
  );
  const canFocusLoginServer = createMemo(
    () =>
      groupMemberEdit() === null &&
      !busy() &&
      !serversLoading() &&
      serverError() === "",
  );
  const serverOptions = createMemo(() => servers());
  const selectedLaunchServer = createMemo(() => {
    const serverName = launchServer();
    return serverName === ""
      ? undefined
      : serverOptions().find((server) => server.name === serverName);
  });
  const serverOverlaySelection = createMemo(() => {
    const server = selectedLaunchServer();
    return server !== undefined && serverInputValue() === launchServer()
      ? server
      : undefined;
  });
  const selectedServerDisplayValue = createMemo(() => launchServer());
  const selectedServerInputValue = createMemo(() => launchServer());
  const pingForServer = (
    server: AccountGameServer,
  ): AccountGameServerPing | undefined => serverPings().get(server.name);
  const serverPingDisplayState = (
    server: AccountGameServer,
  ): ServerPingDisplayState | null => {
    const ping = pingForServer(server);
    const loading = serverPingsLoading();
    const label = serverPingLabel(server, ping, loading);

    return label === ""
      ? null
      : {
          label,
          quality: serverPingQuality(server, ping, loading),
        };
  };
  const filteredServerOptions = createMemo(() => {
    const query = serverSearchQuery().trim().toLowerCase();
    if (query === "") {
      return serverOptions();
    }

    return serverOptions().filter((server) =>
      server.name.toLowerCase().includes(query),
    );
  });
  const showNoServerOption = createMemo(() => {
    const query = serverSearchQuery().trim().toLowerCase();
    return query === "" || "none".includes(query);
  });
  const serverRefreshCoolingDown = createMemo(
    () => serverRefreshNow() < serverRefreshCooldownUntil(),
  );
  const selectedScriptPath = createMemo(() => {
    const payload = launchScript();
    return payload?.path ?? payload?.name ?? "";
  });
  const selectedScriptLabel = createMemo(() => {
    const payload = launchScript();
    return payload?.name ?? payload?.path ?? "";
  });
  const accountLaunchModeLabel = createMemo(() =>
    accountLaunchMode() === "auto-grid" ? "Auto grid" : "Default placement",
  );
  const startSelectedTooltip = createMemo(() =>
    primaryAccountLaunchMode() === "auto-grid"
      ? "Launch in a grid"
      : "Launch accounts",
  );
  const launchOptionsTooltip = createMemo(() => {
    const currentMode = `Window arrangement: ${accountLaunchModeLabel()}`;
    const arrangement = hasMultipleSelectedAccounts()
      ? currentMode
      : `${currentMode}. Applies when launching multiple accounts.`;
    const windowBehavior = launchInNewWindow()
      ? "Accounts launched together share a new window."
      : "An available game window may be used.";
    return `${arrangement} ${windowBehavior}`;
  });
  const launchOptionsAriaLabel = createMemo(() => {
    const arrangement = `Window arrangement: ${accountLaunchModeLabel()}.`;
    return `Choose launch options. ${arrangement} Launch in new window: ${launchInNewWindow() ? "on" : "off"}.`;
  });
  const groupMemberLabel = (username: string): string => {
    const accountLookup = accountsByUsername();
    const account = accountLookup.get(username);
    if (account === undefined || account.label === username) {
      return username;
    }

    return `${account.label} (${username})`;
  };
  const groupMemberSummary = (usernames: readonly string[]): string =>
    usernames.map(groupMemberLabel).join(", ");
  const searchAccountsHotkeyDisplay = createMemo(() =>
    formatHotkeyDisplay(SEARCH_ACCOUNTS_HOTKEY, props.platform),
  );
  const searchAccountsHotkeyDisplayParts = createMemo(() =>
    formatHotkeyDisplayParts(SEARCH_ACCOUNTS_HOTKEY, props.platform),
  );
  const savedGroupsHotkeyDisplay = createMemo(() =>
    formatHotkeyDisplay(SAVED_GROUPS_HOTKEY, props.platform),
  );
  const savedGroupsHotkeyDisplayParts = createMemo(() =>
    formatHotkeyDisplayParts(SAVED_GROUPS_HOTKEY, props.platform),
  );
  const newAccountHotkeyDisplay = createMemo(() =>
    formatHotkeyDisplay(NEW_ACCOUNT_HOTKEY, props.platform),
  );
  const newAccountHotkeyDisplayParts = createMemo(() =>
    formatHotkeyDisplayParts(NEW_ACCOUNT_HOTKEY, props.platform),
  );
  const launchTabHotkeyDisplay = createMemo(() =>
    formatHotkeyDisplay(LAUNCH_TAB_HOTKEY, props.platform),
  );
  const launchTabHotkeyDisplayParts = createMemo(() =>
    formatHotkeyDisplayParts(LAUNCH_TAB_HOTKEY, props.platform),
  );
  const sessionsTabHotkeyDisplay = createMemo(() =>
    formatHotkeyDisplay(SESSIONS_TAB_HOTKEY, props.platform),
  );
  const sessionsTabHotkeyDisplayParts = createMemo(() =>
    formatHotkeyDisplayParts(SESSIONS_TAB_HOTKEY, props.platform),
  );
  const loginServerHotkeyDisplay = createMemo(() =>
    formatHotkeyDisplay(LOGIN_SERVER_HOTKEY, props.platform),
  );
  const loginServerHotkeyDisplayParts = createMemo(() =>
    formatHotkeyDisplayParts(LOGIN_SERVER_HOTKEY, props.platform),
  );
  const selectScriptHotkeyDisplay = createMemo(() =>
    formatHotkeyDisplay(SELECT_SCRIPT_HOTKEY, props.platform),
  );
  const selectScriptHotkeyDisplayParts = createMemo(() =>
    formatHotkeyDisplayParts(SELECT_SCRIPT_HOTKEY, props.platform),
  );
  const startSelectedHotkeyDisplay = createMemo(() =>
    formatHotkeyDisplay(START_SELECTED_HOTKEY, props.platform),
  );
  const startSelectedHotkeyDisplayParts = createMemo(() =>
    formatHotkeyDisplayParts(START_SELECTED_HOTKEY, props.platform),
  );
  const modAriaKey = createMemo(() =>
    props.platform === "mac" ? "Meta" : "Control",
  );
  const newAccountAriaKeyshortcuts = createMemo(() => `${modAriaKey()}+N`);
  const launchTabAriaKeyshortcuts = createMemo(() => `${modAriaKey()}+1`);
  const sessionsTabAriaKeyshortcuts = createMemo(() => `${modAriaKey()}+2`);
  const loginServerAriaKeyshortcuts = createMemo(() => `${modAriaKey()}+L`);
  const selectScriptAriaKeyshortcuts = createMemo(() => `${modAriaKey()}+O`);
  const startSelectedAriaKeyshortcuts = createMemo(
    () => `${modAriaKey()}+Enter`,
  );
  const launchCapacityWarning = createMemo<LaunchCapacityWarning | null>(() => {
    const server = selectedLaunchServer();
    const launchCount = selectedAccountCount();
    if (server === undefined || !server.online || launchCount === 0) {
      return null;
    }

    const openSlots = Math.max(server.maxPlayers - server.playerCount, 0);
    const slotsAfterLaunch = openSlots - launchCount;
    if (slotsAfterLaunch > SERVER_CAPACITY_WARNING_MIN_SPARE_SLOTS) {
      return null;
    }

    if (slotsAfterLaunch >= 0) {
      return {
        label: "Nearly full",
        message: "This server may fill before launch.",
      };
    }

    const excessCount = Math.abs(slotsAfterLaunch);
    return {
      label: "Not enough slots",
      message: `${openSlots} open ${pluralize(
        openSlots,
        "slot",
      )}, but ${launchCount} ${pluralize(
        launchCount,
        "account is",
        "accounts are",
      )} selected. ${excessCount} ${pluralize(
        excessCount,
        "account",
      )} might not get in.`,
    };
  });
  const accountManagerOverlayOpen = (): boolean =>
    dialogOpen() ||
    groupDialogOpen() ||
    groupManagerOpen() ||
    hasOpenAlertDialog();
  const accountManagerShortcutsBlocked = (): boolean =>
    busy() || accountManagerOverlayOpen();
  const ignoreAccountManagerShortcut = (event: KeyboardEvent): boolean =>
    event.repeat || accountManagerShortcutsBlocked();
  const ignoreAccountManagerActionShortcut = (event: KeyboardEvent): boolean =>
    ignoreAccountManagerShortcut(event) || groupMemberEdit() !== null;
  const focusAccountSearch = (): void => {
    suppressAccountSearchTooltipFocus = true;
    setAccountSearchTooltipOpen(false);
    accountSearchInput?.focus();
    accountSearchInput?.select();
    queueMicrotask(() => {
      suppressAccountSearchTooltipFocus = false;
    });
  };
  const clearAccountSearch = (): void => {
    setAccountSearchTooltipOpen(false);
    setSearchQuery("");
    window.requestAnimationFrame(() => accountSearchInput?.focus());
  };
  const rememberAccountDialogReturnFocus = (preferred?: HTMLElement): void => {
    if (accountDialogRestoreFrame !== undefined) {
      window.cancelAnimationFrame(accountDialogRestoreFrame);
      accountDialogRestoreFrame = undefined;
    }
    accountDialogReturnFocus =
      preferred ??
      (document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null);
  };
  const closeAccountDialog = (): void => {
    if (accountDialogRestoreFrame !== undefined) {
      window.cancelAnimationFrame(accountDialogRestoreFrame);
    }
    setDialogOpen(false);
    const returnFocus = accountDialogReturnFocus;
    accountDialogRestoreFrame = window.requestAnimationFrame(() => {
      accountDialogRestoreFrame = window.requestAnimationFrame(() => {
        accountDialogRestoreFrame = undefined;
        accountDialogReturnFocus = null;
        if (
          document.activeElement !== document.body &&
          document.activeElement?.isConnected
        ) {
          return;
        }

        if (returnFocus?.isConnected) {
          returnFocus.focus({ preventScroll: true });
          return;
        }

        document
          .querySelector<HTMLButtonElement>("[data-account-add]")
          ?.focus({ preventScroll: true });
      });
    });
  };
  const leaveGroupMemberEdit = (options?: {
    readonly preserveDraftSelection?: boolean;
  }): void => {
    const edit = groupMemberEdit();
    if (edit === null) {
      return;
    }

    if (!options?.preserveDraftSelection) {
      const usernames = accountUsernames();
      setSelectedAccountUsernames(
        new Set(
          [...edit.launchUsernames].filter((username) =>
            usernames.has(username),
          ),
        ),
      );
    }
    setSearchQuery(edit.launchSearchQuery);
    setGroupMemberEdit(null);
    setGroupMemberEditError("");
    setGroupMemberEditNameError("");
    setGroupMemberEditExitRequest(null);
  };
  const requestGroupMemberEditExit = (
    request: GroupMemberEditExitRequest,
  ): void => {
    if (!groupMemberEditDirty()) {
      leaveGroupMemberEdit();
      if (request.type === "tab") {
        activateAccountManagerTab(request.tab);
      }
      return;
    }

    setGroupMemberEditExitRequest(request);
  };
  const activateAccountManagerTab = (tab: AccountManagerTab): void => {
    if (tab !== "launch" && groupMemberEdit() !== null) {
      requestGroupMemberEditExit({ tab, type: "tab" });
      return;
    }

    setAccountSearchTooltipOpen(false);
    setScriptSelectionTooltipOpen(false);
    setLoginServerTooltipOpen(false);
    setStartOptionsOpen(false);

    if (tab !== "launch") {
      updateGroupComboboxOpen(false);
      setServerComboboxOpen(false);
    }

    setActiveTab(tab);
  };
  const openAccountSearch = (): void => {
    if (activeTab() !== "launch") {
      activateAccountManagerTab("launch");
      window.requestAnimationFrame(focusAccountSearch);
      return;
    }

    focusAccountSearch();
  };
  const openGroupSelector = (): void => {
    if (groupMemberEdit() !== null) {
      return;
    }

    const open = () => {
      setGroupSearchQuery("");
      setGroupComboboxInputValue(selectedGroupName());
      updateGroupComboboxOpen(true);
      groupComboboxInput?.focus();
      groupComboboxInput?.select();
    };

    if (activeTab() !== "launch") {
      activateAccountManagerTab("launch");
      window.requestAnimationFrame(open);
      return;
    }

    open();
  };
  onMount(() => {
    const handleSavedGroupsKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !matchesKeyboardEvent(event, SAVED_GROUPS_HOTKEY) ||
        isEditableHotkeyTarget(event.target) ||
        accountManagerShortcutsBlocked() ||
        groupMemberEdit() !== null ||
        groupEntries().length === 0
      ) {
        return;
      }

      // Capture the app shortcut before another composite control handles G.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || groupComboboxOpen()) {
        return;
      }

      openGroupSelector();
    };

    window.addEventListener("keydown", handleSavedGroupsKeyDown, {
      capture: true,
    });
    onCleanup(() => {
      window.removeEventListener("keydown", handleSavedGroupsKeyDown, {
        capture: true,
      });
    });
  });
  const openServerSelector = (): void => {
    const open = () => {
      setLoginServerTooltipOpen(false);
      serverComboboxInput?.focus();
      serverComboboxInput?.select();
      if (!serverComboboxOpen()) {
        serverFieldElement
          ?.querySelector<HTMLButtonElement>(".combobox__trigger")
          ?.click();
      }
    };

    if (activeTab() !== "launch") {
      activateAccountManagerTab("launch");
      window.requestAnimationFrame(open);
      return;
    }

    open();
  };
  createHotkey(
    LAUNCH_TAB_HOTKEY,
    (event) => {
      if (event.repeat || accountManagerOverlayOpen()) {
        return;
      }

      event.preventDefault();
      activateAccountManagerTab("launch");
    },
    {
      eventType: "keydown",
      conflictBehavior: "replace",
      ignoreInputs: false,
      preventDefault: false,
      stopPropagation: false,
    },
  );

  createHotkey(
    SESSIONS_TAB_HOTKEY,
    (event) => {
      if (event.repeat || accountManagerOverlayOpen()) {
        return;
      }

      event.preventDefault();
      activateAccountManagerTab("sessions");
    },
    {
      eventType: "keydown",
      conflictBehavior: "replace",
      ignoreInputs: false,
      preventDefault: false,
      stopPropagation: false,
    },
  );

  createHotkey(
    SEARCH_ACCOUNTS_HOTKEY,
    (event) => {
      if (ignoreAccountManagerShortcut(event)) {
        return;
      }

      event.preventDefault();
      openAccountSearch();
    },
    {
      eventType: "keydown",
      conflictBehavior: "replace",
      ignoreInputs: true,
      preventDefault: false,
      stopPropagation: false,
    },
  );

  createHotkey(
    NEW_ACCOUNT_HOTKEY,
    (event) => {
      if (ignoreAccountManagerActionShortcut(event)) {
        return;
      }

      event.preventDefault();
      openCreateDialog();
    },
    {
      eventType: "keydown",
      conflictBehavior: "replace",
      ignoreInputs: false,
      preventDefault: false,
      stopPropagation: false,
    },
  );

  createHotkey(
    SELECT_SCRIPT_HOTKEY,
    (event) => {
      if (ignoreAccountManagerActionShortcut(event)) {
        return;
      }

      event.preventDefault();
      if (activeTab() !== "launch") {
        activateAccountManagerTab("launch");
      }
      void handleLoadScript();
    },
    {
      eventType: "keydown",
      conflictBehavior: "replace",
      ignoreInputs: false,
      preventDefault: false,
      stopPropagation: false,
    },
  );

  createHotkey(
    LOGIN_SERVER_HOTKEY,
    (event) => {
      if (ignoreAccountManagerActionShortcut(event) || !canFocusLoginServer()) {
        return;
      }

      event.preventDefault();
      openServerSelector();
    },
    {
      eventType: "keydown",
      conflictBehavior: "replace",
      ignoreInputs: false,
      preventDefault: false,
      stopPropagation: false,
    },
  );

  createHotkey(
    START_SELECTED_HOTKEY,
    (event) => {
      if (ignoreAccountManagerActionShortcut(event) || !canStartSelected()) {
        return;
      }

      event.preventDefault();
      void handleLaunch();
    },
    {
      eventType: "keydown",
      conflictBehavior: "replace",
      ignoreInputs: false,
      preventDefault: false,
      stopPropagation: false,
    },
  );

  createEffect(() => {
    if (dialogOpen()) {
      window.requestAnimationFrame(() => {
        usernameInput?.focus();
      });
    }
  });

  createEffect(() => {
    if (!serverInputFocused() && !serverComboboxOpen()) {
      setServerInputValue(selectedServerDisplayValue());
    }
  });

  createEffect(() => {
    const value = serverInputValue();
    queueMicrotask(() => {
      if (
        serverComboboxInput !== undefined &&
        serverComboboxInput.value !== value
      ) {
        serverComboboxInput.value = value;
      }
    });
  });

  const applyState = (incomingState: AccountManagerState) => {
    const previousState = state();
    const nextState = reconcileAccountManagerState(
      previousState,
      incomingState,
    );
    if (nextState !== previousState) {
      setState(nextState);
    }
    setStateLoaded(true);

    const usernames = new Set(
      nextState.accounts.map((account) => account.username),
    );
    const currentGroupMemberEdit = groupMemberEdit();
    const editedGroupWasDeleted =
      currentGroupMemberEdit?.mode === "update" &&
      nextState.groups[currentGroupMemberEdit.name] === undefined;
    setSelectedAccountUsernames((previous) => {
      const source = editedGroupWasDeleted
        ? currentGroupMemberEdit.launchUsernames
        : previous;
      let changed = source !== previous;
      const next = new Set<string>();
      for (const username of source) {
        if (usernames.has(username)) {
          next.add(username);
        } else {
          changed = true;
        }
      }

      return changed ? next : previous;
    });

    if (editedGroupWasDeleted) {
      setSearchQuery(currentGroupMemberEdit.launchSearchQuery);
      setGroupMemberEdit(null);
      setGroupMemberEditError("");
      setGroupMemberEditNameError("");
      setGroupMemberEditExitRequest(null);
    }

    const currentEditingUsername = editingUsername();
    if (currentEditingUsername && !usernames.has(currentEditingUsername)) {
      setEditingUsername(null);
      if (dialogOpen()) {
        closeAccountDialog();
      }
    }
  };

  const setFormField = (field: keyof AccountFormState, value: string) => {
    setForm((previous) => ({
      ...previous,
      [field]: value,
    }));
    setDialogError("");
    if (field === "username" || field === "password") {
      setFormErrors((previous) => ({
        ...previous,
        [field]: undefined,
      }));
    }
  };

  const loadServerPings = async (
    serverSnapshot: readonly AccountGameServer[],
  ) => {
    if (props.callbacks?.getServerPings === undefined) {
      return;
    }

    const requestId = ++serverPingRequestId;
    setServerPings(new Map());

    if (!serverSnapshot.some((server) => server.online)) {
      setServerPingsLoading(false);
      return;
    }

    const serverNames = new Set(serverSnapshot.map((server) => server.name));
    setServerPingsLoading(true);
    try {
      const result = await props.callbacks.getServerPings();
      if (requestId !== serverPingRequestId) {
        return;
      }

      const nextPings = new Map<string, AccountGameServerPing>();
      for (const ping of result.pings) {
        if (serverNames.has(ping.serverName)) {
          nextPings.set(ping.serverName, ping);
        }
      }
      setServerPings(nextPings);
    } catch (error) {
      console.error("Failed to load server pings:", error);
      if (requestId === serverPingRequestId) {
        setServerPings(new Map());
      }
    } finally {
      if (requestId === serverPingRequestId) {
        setServerPingsLoading(false);
      }
    }
  };

  const loadServers = async (options?: { readonly refresh?: boolean }) => {
    const load = options?.refresh
      ? props.callbacks?.refreshServers
      : props.callbacks?.getServers;
    if (load === undefined) {
      return;
    }

    if (serverSelectionSettlingTimeout !== undefined) {
      window.clearTimeout(serverSelectionSettlingTimeout);
      serverSelectionSettlingTimeout = undefined;
    }
    setServersLoading(true);
    setServerSelectionSettling(true);
    setServerError("");
    try {
      const nextServers = await load();
      setServerRefreshCooldownUntil(nextServers.refreshAvailableAt);
      setServers(nextServers.servers);
      void loadServerPings(nextServers.servers);
      if (!serverSelectionInitialized()) {
        const nextLaunchServerResolution = resolveAccountLoginServerPreference(
          nextServers.servers,
          readStoredAccountLoginServerPreference(),
        );
        const nextLaunchServerName =
          nextLaunchServerResolution.type === "server"
            ? nextLaunchServerResolution.name
            : "";
        setLaunchServer(nextLaunchServerName);
        setServerInputValue(nextLaunchServerName);
        setServerSelectionInitialized(true);
      }
    } catch (error) {
      console.error("Failed to load servers:", error);
      const nextMessage =
        error instanceof Error ? error.message : "Server load failed";
      setServerError(nextMessage);
    } finally {
      setServersLoading(false);
      serverSelectionSettlingTimeout = window.setTimeout(() => {
        setServerSelectionSettling(false);
        serverSelectionSettlingTimeout = undefined;
      }, 180);
    }
  };

  const handleRefreshServers = async () => {
    const timestamp = Date.now();
    if (serversLoading() || timestamp < serverRefreshCooldownUntil()) {
      return;
    }

    setServerRefreshNow(timestamp);
    setServerRefreshCooldownUntil(
      timestamp + ACCOUNT_SERVER_REFRESH_COOLDOWN_MS,
    );
    await loadServers({ refresh: true });
  };

  const setLaunchScriptPayload = (payload: AccountScriptReference) => {
    setScriptSelectionTooltipOpen(false);
    setLaunchScript(payload);
    setScriptError("");
  };

  const clearLaunchScript = () => {
    setScriptSelectionTooltipOpen(false);
    setLaunchScript(null);
    setScriptError("");
  };

  const openCreateDialog = () => {
    rememberAccountDialogReturnFocus();
    setEditingUsername(null);
    setDialogMode("create");
    setForm(emptyForm());
    setFormErrors({});
    setDialogError("");
    setPasswordVisible(false);
    setDialogOpen(true);
  };

  const openEditDialog = (
    account: ManagedAccount,
    returnFocus?: HTMLElement,
  ) => {
    rememberAccountDialogReturnFocus(returnFocus);
    setEditingUsername(account.username);
    setDialogMode("edit");
    setForm(toForm(account));
    setFormErrors({});
    setDialogError("");
    setPasswordVisible(false);
    setDialogOpen(true);
  };

  const applyGroup = (groupName: string) => {
    const members = groups()[groupName];
    if (members === undefined) {
      return;
    }

    const usernames = accountUsernames();
    setSelectedAccountUsernames(
      new Set(members.filter((username) => usernames.has(username))),
    );
    setSelectedGroupName(groupName);
    updateGroupComboboxOpen(false);
  };

  const groupManagerInitialFocusElement = (): HTMLButtonElement | null => {
    const targetName = groupManagerFocusTarget();
    if (targetName === null) {
      return null;
    }

    return (
      Array.from(
        document.querySelectorAll<HTMLButtonElement>("[data-group-actions]"),
      ).find((button) => button.dataset["groupName"] === targetName) ?? null
    );
  };

  const openGroupManager = () => {
    setGroupManagerFocusTarget(null);
    setGroupManagerOpen(true);
  };

  const beginGroupCreate = () => {
    if (groupMemberEdit() !== null || selectedAccountUsernames().size === 0) {
      return;
    }

    const originalUsernames = new Set(selectedLaunchUsernames());
    setGroupMemberEdit({
      launchSearchQuery: searchQuery(),
      launchUsernames: new Set(originalUsernames),
      mode: "create",
      name: "",
      originalName: "",
      originalUsernames,
    });
    setGroupMemberEditError("");
    setGroupMemberEditNameError("");
    setSearchQuery("");
    setSelectedAccountUsernames(new Set(originalUsernames));
    activateAccountManagerTab("launch");
    window.requestAnimationFrame(() => groupNameInput?.focus());
  };

  const openRenameGroupDialog = (groupName: string) => {
    const usernames = groups()[groupName];
    if (usernames === undefined) {
      return;
    }

    setGroupManagerFocusTarget(groupName);
    setGroupManagerOpen(false);
    setEditingGroupName(groupName);
    setGroupForm({
      name: groupName,
      usernames: new Set(usernames),
    });
    setGroupDialogError("");
    setGroupNameError("");
    setGroupDialogOpen(true);
  };

  const closeGroupDialog = () => {
    setGroupDialogOpen(false);
    setEditingGroupName(null);

    // Let the rename dialog release its focus trap before reopening its parent.
    queueMicrotask(() => setGroupManagerOpen(true));
  };

  const beginGroupMemberEdit = (groupName: string) => {
    const members = groups()[groupName];
    if (members === undefined || groupMemberEdit() !== null) {
      return;
    }

    const usernames = accountUsernames();
    const originalUsernames = new Set(
      members.filter((username) => usernames.has(username)),
    );
    setGroupManagerOpen(false);
    setGroupMemberEdit({
      launchSearchQuery: searchQuery(),
      launchUsernames: new Set(selectedAccountUsernames()),
      mode: "update",
      name: groupName,
      originalName: groupName,
      originalUsernames,
    });
    setGroupMemberEditError("");
    setGroupMemberEditNameError("");
    setSearchQuery("");
    setSelectedAccountUsernames(new Set(originalUsernames));
    activateAccountManagerTab("launch");
    window.requestAnimationFrame(() => focusAccountSearch());
  };

  const setGroupFormName = (name: string) => {
    setGroupForm((previous) => ({
      ...previous,
      name,
    }));
    setGroupDialogError("");
    setGroupNameError("");
  };

  const setGroupMemberEditName = (name: string) => {
    setGroupMemberEdit((previous) =>
      previous === null ? null : { ...previous, name },
    );
    setGroupMemberEditError("");
    setGroupMemberEditNameError("");
  };

  const handleRenameGroup = async () => {
    const currentGroupName = editingGroupName();
    if (busy() || currentGroupName === null) {
      return;
    }
    if (groupForm().name.trim() === "") {
      setGroupNameError("Enter a group name.");
      window.requestAnimationFrame(() => groupDialogNameInput?.focus());
      return;
    }
    const renamingSelectedGroup = selectedGroupName() === currentGroupName;

    const payload = {
      name: groupForm().name.trim(),
      usernames: [...groupForm().usernames],
    };
    setBusy(true);
    setGroupDialogError("");
    try {
      const nextState = await (props.callbacks?.updateGroup?.(
        currentGroupName,
        payload,
      ) ?? Promise.resolve(state()));

      applyState(nextState);
      if (renamingSelectedGroup) {
        setSelectedGroupName(payload.name);
      }
      setGroupManagerFocusTarget(payload.name);
      closeGroupDialog();
    } catch (error) {
      console.error("Failed to rename group:", error);
      setGroupDialogError(
        error instanceof Error ? error.message : "Rename failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSaveGroupMemberEdit = async () => {
    const edit = groupMemberEdit();
    const usernames = selectedLaunchUsernames();
    if (edit === null || busy()) {
      return;
    }
    if (edit.mode === "create" && edit.name.trim() === "") {
      setGroupMemberEditNameError("Enter a group name.");
      window.requestAnimationFrame(() => groupNameInput?.focus());
      return;
    }
    if (edit.mode === "create" && usernames.length === 0) {
      setGroupMemberEditError("Select at least one account.");
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLInputElement>(
            ".account-list .checkbox__input:not(:disabled)",
          )
          ?.focus();
      });
      return;
    }

    setBusy(true);
    setGroupMemberEditError("");
    setGroupMemberEditNameError("");
    try {
      const payload = {
        name: edit.name.trim(),
        usernames,
      };
      const nextState =
        edit.mode === "create"
          ? await (props.callbacks?.createGroup?.(payload) ??
              Promise.resolve(state()))
          : await (props.callbacks?.updateGroup?.(edit.name, payload) ??
              Promise.resolve(state()));
      applyState(nextState);
      if (edit.mode === "create") {
        setSelectedGroupName(payload.name);
      }
      leaveGroupMemberEdit({ preserveDraftSelection: edit.mode === "create" });
    } catch (error) {
      console.error(
        edit.mode === "create"
          ? "Failed to create group:"
          : "Failed to update group accounts:",
        error,
      );
      setGroupMemberEditError(
        error instanceof Error
          ? error.message
          : edit.mode === "create"
            ? "Unable to create group"
            : "Unable to save changes",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmGroupMemberEditExit = () => {
    const request = groupMemberEditExitRequest();
    leaveGroupMemberEdit();
    if (request?.type === "tab") {
      activateAccountManagerTab(request.tab);
    }
  };

  const handleDeleteGroup = async () => {
    const groupName = groupToDelete();
    if (busy() || groupName === null) {
      return;
    }

    setBusy(true);
    setGroupDeleteError("");
    try {
      const nextState = await (props.callbacks?.deleteGroup?.(groupName) ??
        Promise.resolve(state()));
      applyState(nextState);
      setGroupToDelete(null);
    } catch (error) {
      console.error("Failed to delete group:", error);
      setGroupDeleteError(
        error instanceof Error ? error.message : "Unable to delete group",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (options: SaveOptions) => {
    if (busy()) {
      return;
    }

    const currentForm = form();
    const nextErrors: AccountFormErrors = {
      ...(currentForm.password.trim() === ""
        ? { password: "Enter a password." }
        : {}),
      ...(currentForm.username.trim() === ""
        ? { username: "Enter a username." }
        : {}),
    };
    setFormErrors(nextErrors);
    const firstInvalidInput = nextErrors.username
      ? usernameInput
      : nextErrors.password
        ? passwordInput
        : undefined;
    if (firstInvalidInput !== undefined) {
      window.requestAnimationFrame(() => firstInvalidInput.focus());
      return;
    }

    const payload = toDraft(currentForm);
    const currentEditingUsername = editingUsername();
    setBusy(true);
    setDialogError("");
    try {
      const nextState = currentEditingUsername
        ? await (props.callbacks?.updateAccount?.(
            currentEditingUsername,
            payload,
          ) ?? Promise.resolve(state()))
        : await (props.callbacks?.createAccount?.(payload) ??
            Promise.resolve(state()));

      applyState(nextState);
      if (options.closeAfterSave || currentEditingUsername) {
        closeAccountDialog();
      } else {
        setForm(emptyForm());
        setFormErrors({});
        setPasswordVisible(false);
        window.requestAnimationFrame(() => usernameInput?.focus());
      }
    } catch (error) {
      console.error("Failed to save account:", error);
      setDialogError(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const accountFormIncomplete = () =>
    form().username.trim() === "" || form().password.trim() === "";

  const deleteAccountUsernames = async (usernames: readonly string[]) => {
    setBusy(true);
    try {
      const deleteAccounts = props.callbacks?.deleteAccounts;
      let nextState =
        deleteAccounts === undefined
          ? state()
          : await deleteAccounts(usernames);
      if (deleteAccounts === undefined) {
        for (const username of usernames) {
          nextState = await (props.callbacks?.deleteAccount?.(username) ??
            Promise.resolve(nextState));
        }
      }
      applyState(nextState);
      setSelectedAccountUsernames((previous) => {
        const next = new Set(previous);
        for (const username of usernames) {
          next.delete(username);
        }
        return next;
      });
    } catch (error) {
      console.error("Failed to delete accounts:", error);
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveSelected = async () => {
    const usernames = [...selectedAccountUsernames()];
    if (usernames.length === 0) {
      return;
    }

    await deleteAccountUsernames(usernames);
  };

  const handleDeleteCurrentAccount = async () => {
    const username = editingUsername();
    if (!username) {
      return;
    }

    await deleteAccountUsernames([username]);
    closeAccountDialog();
  };

  const launchAccountUsernames = async (
    usernames: readonly string[],
    launchMode: AccountLaunchMode,
    script: AccountScriptReference | null,
  ) => {
    if (usernames.length === 0) {
      return;
    }

    setBusy(true);
    const server = launchServer();
    const useNewWindow = useGameTabs() && launchInNewWindow();
    let firstGameWindowId: number | undefined;
    try {
      for (const username of usernames) {
        try {
          const windowTarget = resolveAccountLaunchWindowTarget(
            useNewWindow,
            firstGameWindowId,
          );
          const result = await (props.callbacks?.launch?.({
            username,
            script,
            ...(server === "" ? {} : { server }),
            ...(launchMode === "auto-grid" ? { gameViewLayout: "grid" } : {}),
            ...(windowTarget === undefined ? {} : { windowTarget }),
          }) ?? Promise.resolve({ gameWindowId: -1 }));
          if (useNewWindow && firstGameWindowId === undefined) {
            firstGameWindowId = result.gameWindowId;
          }
        } catch (error) {
          console.error(`Failed to launch account ${username}:`, error);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const handleLaunchAccountUsername = async (
    username: string,
    script: AccountScriptReference | null,
  ) => {
    await launchAccountUsernames([username], "standard", script);
  };

  const selectAccountLaunchMode = (mode: AccountLaunchMode): void => {
    setAccountLaunchMode(mode);
    writeStoredAccountLaunchMode(mode);
    setStartOptionsOpen(false);
  };

  const selectLaunchInNewWindow = (enabled: boolean): void => {
    setLaunchInNewWindow(enabled);
    writeStoredAccountLaunchInNewWindow(enabled);
  };

  const handleLaunch = async () => {
    const usernames = selectedLaunchUsernames();
    const launchMode =
      usernames.length > 1 ? primaryAccountLaunchMode() : "standard";

    setStartOptionsOpen(false);
    await launchAccountUsernames(usernames, launchMode, launchScript());
  };

  const accountDisplayLabel = (username: string): string =>
    accountsByUsername().get(username)?.label ?? username;

  const activeWindowAccountIdentity = (session: AccountGameSession) => {
    const username = activeWindowAccountUsername(session);
    const accountLabel =
      username === undefined
        ? "Unknown account"
        : accountDisplayLabel(username);

    return {
      label: accountLabel,
      username:
        username !== undefined && accountLabel !== username
          ? username
          : undefined,
    };
  };

  const closeGameWindowDescription = (session: AccountGameSession): string => {
    const hasActiveScript =
      session.script.state === "starting" || session.script.state === "running";
    const username = activeWindowAccountUsername(session);
    const accountLabel =
      username === undefined ? undefined : accountDisplayLabel(username);
    const closeTarget =
      accountLabel === undefined
        ? "this game session"
        : `the game session for “${accountLabel}”`;

    return hasActiveScript
      ? `Stop the script, log out, and close ${closeTarget}?`
      : `Log out and close ${closeTarget}?`;
  };

  const closeAllGameWindowsDescription = (
    sessions: readonly AccountGameSession[],
  ): string => {
    const activeScriptCount = sessions.filter(
      (session) =>
        session.script.state === "starting" ||
        session.script.state === "running",
    ).length;
    const windowCount = sessions.length;
    const sessionLabel = `${windowCount} ${pluralize(
      windowCount,
      "game session",
    )}`;

    if (windowCount === 1) {
      return activeScriptCount > 0
        ? "Stop the script, log out, and close this game session?"
        : "Log out and close this game session?";
    }

    return activeScriptCount > 0
      ? `Stop ${activeScriptCount} active ${pluralize(
          activeScriptCount,
          "script",
        )}, log out, and close all ${sessionLabel}?`
      : `Log out and close all ${sessionLabel}?`;
  };

  const openSessionCloseDialog = (request: SessionCloseRequest) => {
    setSessionCloseRequest(request);
    setSessionCloseDialogOpen(true);
  };

  const handleFocusTrackedGameWindow = async (session: AccountGameSession) => {
    const gameWindowId = session.gameWindowId;

    try {
      const nextState = await (props.callbacks?.focusGameWindow?.({
        gameWindowId,
      }) ?? Promise.resolve(state()));
      applyState(nextState);
    } catch (error) {
      console.error("Failed to focus tracked game session:", error);
    }
  };

  const handleCloseTrackedGameWindows = async (
    sessions: readonly AccountGameSession[],
  ) => {
    const alreadyClosing = closingGameWindowIds();
    const sessionsByWindowId = new Map(
      sessions
        .filter((session) => !alreadyClosing.has(session.gameWindowId))
        .map((session) => [session.gameWindowId, session] as const),
    );
    if (sessionsByWindowId.size === 0) {
      return;
    }

    setClosingGameWindowIds((previous) => {
      const next = new Set(previous);
      for (const gameWindowId of sessionsByWindowId.keys()) {
        next.add(gameWindowId);
      }
      return next;
    });

    const gameWindowIds = [...sessionsByWindowId.keys()];
    try {
      if (props.callbacks?.closeGameWindows !== undefined) {
        applyState(await props.callbacks.closeGameWindows(gameWindowIds));
        return;
      }

      let nextState = state();
      for (const gameWindowId of gameWindowIds) {
        try {
          nextState = await (props.callbacks?.closeGameWindow?.({
            gameWindowId,
          }) ?? Promise.resolve(nextState));
        } catch (error) {
          console.error("Failed to close tracked game window:", error);
        }
      }
      applyState(nextState);
    } catch (error) {
      console.error("Failed to close tracked game windows:", error);
    } finally {
      const closedIds = new Set(gameWindowIds);
      setClosingGameWindowIds((previous) => {
        const next = new Set(previous);
        for (const gameWindowId of closedIds) {
          next.delete(gameWindowId);
        }
        return next;
      });
    }
  };

  const handleCloseAllTrackedGameWindows = async () => {
    setBulkClosingGameWindows(true);
    try {
      await handleCloseTrackedGameWindows(activeWindowSessions());
    } finally {
      setBulkClosingGameWindows(false);
    }
  };

  const handleLoadScript = async () => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null;
    setScriptSelectionTooltipOpen(false);
    setBusy(true);
    setScriptError("");
    try {
      const result = await (props.callbacks?.selectScript?.() ??
        Promise.resolve({ canceled: true }));
      if (result.canceled) {
        return;
      }

      setLaunchScriptPayload(result.file);
    } catch (error) {
      console.error("Failed to load script:", error);
      setScriptError(
        error instanceof Error ? error.message : "Unable to choose a script.",
      );
    } finally {
      setBusy(false);
      window.requestAnimationFrame(() => {
        const fallback = document.querySelector<HTMLButtonElement>(
          "[data-account-script-chooser]",
        );
        const focusTarget = previouslyFocused?.isConnected
          ? previouslyFocused
          : fallback;
        focusTarget?.focus();
      });
    }
  };

  const confirmRemoveSelectedDescription = (): string => {
    const count = selectedAccountUsernames().size;

    return count === 1
      ? "Remove the selected account and its saved login details?"
      : `Remove ${count} selected accounts and their saved login details?`;
  };

  const selectedRemoveLabel = (): string =>
    selectedAccountUsernames().size === 1
      ? "Remove account"
      : "Remove accounts";

  const selectedRemoveConfirmLabel = (): string =>
    selectedAccountUsernames().size === 1
      ? "Remove account"
      : "Remove accounts";

  const handleDeleteAccountUsername = async (username: string) => {
    await deleteAccountUsernames([username]);
  };

  const toggleSelected = (username: string, checked: boolean) => {
    setSelectedAccountUsernames((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(username);
      } else {
        next.delete(username);
      }
      return next;
    });
  };

  const clearSelectedAccounts = () => {
    setSelectedAccountUsernames(new Set<string>());
  };

  onMount(() => {
    const unsubscribe = props.callbacks?.onChanged?.(applyState);
    const unsubscribeUseGameTabs = props.callbacks?.onUseGameTabsChanged?.(
      (enabled) => {
        setUseGameTabs(enabled);
        if (!enabled) setStartOptionsOpen(false);
      },
    );
    const loadingIndicatorTimeout =
      props.callbacks?.getState === undefined
        ? undefined
        : window.setTimeout(() => {
            if (!stateLoaded()) {
              setInitialLoadingVisible(true);
            }
          }, INITIAL_LOADING_INDICATOR_DELAY_MS);
    const refreshCooldownTimer = window.setInterval(() => {
      setServerRefreshNow(Date.now());
    }, 1_000);

    if (props.callbacks?.getState !== undefined) {
      void props.callbacks
        .getState()
        .then(async (nextState) => {
          applyState(nextState);
        })
        .catch((error) => {
          console.error("Failed to load accounts:", error);
          setStateLoaded(true);
        });
    }

    void loadServers();

    onCleanup(() => {
      unsubscribe?.();
      unsubscribeUseGameTabs?.();
      serverPingRequestId += 1;
      if (loadingIndicatorTimeout !== undefined) {
        window.clearTimeout(loadingIndicatorTimeout);
      }
      window.clearInterval(refreshCooldownTimer);
      if (serverSelectionSettlingTimeout !== undefined) {
        window.clearTimeout(serverSelectionSettlingTimeout);
      }
    });
  });

  return (
    <Tabs
      aria-label="Account Manager views"
      class="account-manager"
      ids={{ trigger: accountManagerTabTriggerId }}
      onValueChange={(details) =>
        activateAccountManagerTab(details.value as AccountManagerTab)
      }
      value={activeTab()}
    >
      <header class="account-manager__navigation">
        <TabsList
          aria-label="Account Manager views"
          class="account-manager__tabs-list"
          variant="underline"
        >
          <AccountManagerTabTrigger
            keyshortcuts={launchTabAriaKeyshortcuts()}
            shortcutLabel={launchTabHotkeyDisplay()}
            shortcutParts={launchTabHotkeyDisplayParts()}
            tooltipLabel="Open Launch view"
            value="launch"
          >
            Launch
          </AccountManagerTabTrigger>
          <AccountManagerTabTrigger
            keyshortcuts={sessionsTabAriaKeyshortcuts()}
            shortcutLabel={sessionsTabHotkeyDisplay()}
            shortcutParts={sessionsTabHotkeyDisplayParts()}
            tooltipLabel="Open Sessions view"
            value="sessions"
          >
            Sessions
            <Badge
              aria-label={
                activeWindowSessions().length +
                " " +
                pluralize(activeWindowSessions().length, "active session")
              }
              class="account-manager__sessions-count"
              variant="outline"
            >
              {activeWindowSessions().length}
            </Badge>
          </AccountManagerTabTrigger>
        </TabsList>
        <Show when={groupMemberEdit() === null}>
          <Tooltip closeDelay={0} openDelay={ACTION_TOOLTIP_OPEN_DELAY_MS}>
            <TooltipTrigger
              asChild={(triggerProps) => (
                <Button
                  {...(triggerProps({
                    "aria-label": "Add account",
                    "aria-keyshortcuts": newAccountAriaKeyshortcuts(),
                    class: "account-manager__add-account",
                    "data-account-add": "",
                    onClick: openCreateDialog,
                  } as ButtonProps) as ButtonProps)}
                >
                  <Icon icon="plus" class="button__icon" />
                  <span class="account-manager__add-account-label">
                    Add account
                  </span>
                </Button>
              )}
            />
            <TooltipContent>
              Add account{" "}
              <ShortcutKbd
                label={newAccountHotkeyDisplay()}
                parts={newAccountHotkeyDisplayParts()}
              />
            </TooltipContent>
          </Tooltip>
        </Show>
      </header>

      <main class="account-manager__main">
        <TabsContent
          class="account-manager__pane account-manager__pane--launch"
          value="launch"
        >
          <section
            class="account-manager__surface"
            aria-label={
              groupMemberEdit() === null
                ? "Launch accounts"
                : groupMemberEdit()?.mode === "create"
                  ? "Create group"
                  : `Choose accounts for “${groupMemberEdit()?.name ?? "this group"}”`
            }
          >
            <div class="account-manager__accounts-panel">
              <div class="account-manager__account-tools">
                <div class="account-manager__toolbar-field">
                  <Label for="account-manager-account-search">Accounts</Label>
                  <Tooltip
                    closeDelay={0}
                    open={accountSearchTooltipOpen()}
                    openDelay={FIELD_TOOLTIP_OPEN_DELAY_MS}
                    unmountOnExit
                    onOpenChange={(details) =>
                      setAccountSearchTooltipOpen(
                        details.open && !suppressAccountSearchTooltipFocus,
                      )
                    }
                  >
                    <InputGroup class="account-search" size="lg">
                      <InputGroupAddon
                        align="inline-start"
                        class="account-search__icon"
                      >
                        <Icon aria-hidden="true" icon="search" />
                      </InputGroupAddon>
                      <TooltipTrigger
                        asChild={(triggerProps) => (
                          <InputGroupInput
                            {...(triggerProps({
                              "aria-keyshortcuts": SEARCH_ACCOUNTS_HOTKEY,
                              id: "account-manager-account-search",
                              ref: (element) => {
                                accountSearchInput = element;
                              },
                              value: searchQuery(),
                              placeholder: "Search accounts",
                              onInput: (event) => {
                                setAccountSearchTooltipOpen(false);
                                setSearchQuery(event.currentTarget.value);
                              },
                              onKeyDown: (event) => {
                                setAccountSearchTooltipOpen(false);
                                if (event.key !== "Escape") {
                                  return;
                                }

                                if (searchQuery() !== "") {
                                  event.preventDefault();
                                  const input = event.currentTarget;
                                  setSearchQuery("");
                                  window.requestAnimationFrame(() =>
                                    input.focus(),
                                  );
                                  return;
                                }

                                event.currentTarget.blur();
                              },
                            } satisfies InputGroupInputProps as unknown as Parameters<
                              typeof triggerProps
                            >[0]) as unknown as InputGroupInputProps)}
                          />
                        )}
                      />
                    </InputGroup>
                    <TooltipContent>
                      Search accounts{" "}
                      <ShortcutKbd
                        label={searchAccountsHotkeyDisplay()}
                        parts={searchAccountsHotkeyDisplayParts()}
                      />
                    </TooltipContent>
                  </Tooltip>
                </div>

                <Show
                  when={groupMemberEdit()}
                  fallback={
                    <div class="account-manager__toolbar-field">
                      <div class="account-manager__toolbar-label">
                        <label for={SAVED_GROUPS_TRIGGER_ID}>
                          Saved groups
                        </label>
                        <Button
                          aria-label="Manage saved groups"
                          class="account-manager__manage-groups"
                          disabled={busy() || groupEntries().length === 0}
                          onClick={openGroupManager}
                          type="button"
                          variant="ghost"
                        >
                          Manage
                        </Button>
                      </div>
                      <div class="account-manager__group-controls">
                        <div class="account-manager__group-field">
                          <Tooltip
                            closeDelay={0}
                            disabled={
                              groupEntries().length === 0 || groupComboboxOpen()
                            }
                            ids={{ trigger: SAVED_GROUPS_TRIGGER_ID }}
                            open={
                              groupComboboxTooltipOpen() && !groupComboboxOpen()
                            }
                            openDelay={FIELD_TOOLTIP_OPEN_DELAY_MS}
                            unmountOnExit
                            onOpenChange={(details) =>
                              setGroupComboboxTooltipOpen(
                                details.open &&
                                  !groupComboboxOpen() &&
                                  !suppressGroupComboboxTooltipFocus,
                              )
                            }
                          >
                            <Combobox
                              class="account-manager__group-combobox"
                              ids={{ input: SAVED_GROUPS_TRIGGER_ID }}
                              items={groupComboboxItems()}
                              value={
                                selectedGroupName() === ""
                                  ? []
                                  : [selectedGroupName()]
                              }
                              disabled={groupEntries().length === 0}
                              inputBehavior="autohighlight"
                              inputValue={groupComboboxInputValue()}
                              open={groupComboboxOpen()}
                              openOnClick
                              positioning={{
                                fitViewport: true,
                                hideWhenDetached: true,
                                listeners: { animationFrame: true },
                                overflowPadding: 8,
                                sameWidth: true,
                              }}
                              unmountOnExit
                              onOpenChange={(details) =>
                                updateGroupComboboxOpen(details.open)
                              }
                              onInputValueChange={(details) => {
                                if (details.reason === "input-change") {
                                  replaceGroupInputOnEdit = false;
                                  setGroupComboboxInputValue(
                                    details.inputValue,
                                  );
                                  setGroupSearchQuery(details.inputValue);
                                } else if (details.reason === "item-select") {
                                  setGroupComboboxInputValue(
                                    details.inputValue,
                                  );
                                  setGroupSearchQuery("");
                                }
                              }}
                              onValueChange={(details) => {
                                const groupName = details.value[0];
                                if (groupName !== undefined) {
                                  applyGroup(groupName);
                                }
                              }}
                            >
                              <TooltipTrigger
                                asChild={(triggerProps) => (
                                  <ComboboxInput
                                    {...(triggerProps({
                                      ref: (element) => {
                                        groupComboboxInput = element;
                                      },
                                      "aria-keyshortcuts": SAVED_GROUPS_HOTKEY,
                                      placeholder: "Apply a group…",
                                      showClear: false,
                                      size: "lg",
                                      triggerProps: {
                                        onPointerDown: () => {
                                          replaceGroupInputOnEdit =
                                            selectedGroupName() !== "";
                                        },
                                      },
                                      value: groupComboboxInputValue(),
                                      onBlur: () => {
                                        replaceGroupInputOnEdit = false;
                                        if (!groupComboboxOpen()) {
                                          setGroupSearchQuery("");
                                          setGroupComboboxInputValue(
                                            selectedGroupName(),
                                          );
                                        }
                                      },
                                      onFocus: () => {
                                        replaceGroupInputOnEdit =
                                          !groupComboboxOpen() &&
                                          selectedGroupName() !== "";
                                      },
                                      onKeyDown: (event) => {
                                        const replacesCurrentValue =
                                          replaceGroupInputOnEdit &&
                                          !event.isComposing &&
                                          !event.altKey &&
                                          !event.ctrlKey &&
                                          !event.metaKey &&
                                          (event.key === "Backspace" ||
                                            event.key === "Delete" ||
                                            event.key.length === 1);
                                        if (replacesCurrentValue) {
                                          event.currentTarget.select();
                                          replaceGroupInputOnEdit = false;
                                        } else if (
                                          event.key === "ArrowLeft" ||
                                          event.key === "ArrowRight" ||
                                          event.key === "Home" ||
                                          event.key === "End"
                                        ) {
                                          replaceGroupInputOnEdit = false;
                                        }
                                      },
                                      onPointerDown: () => {
                                        replaceGroupInputOnEdit =
                                          !groupComboboxOpen() &&
                                          selectedGroupName() !== "";
                                      },
                                    } satisfies ComboboxInputProps as unknown as Parameters<
                                      typeof triggerProps
                                    >[0]) as unknown as ComboboxInputProps)}
                                  />
                                )}
                              />
                              <ComboboxContent class="account-manager__group-content">
                                <Show
                                  when={filteredGroupEntries().length === 0}
                                >
                                  <ComboboxEmpty>
                                    No matching groups
                                  </ComboboxEmpty>
                                </Show>
                                <ComboboxList>
                                  <For each={filteredGroupEntries()}>
                                    {([name, usernames]) => (
                                      <SavedGroupOption
                                        memberLabels={usernames.map(
                                          groupMemberLabel,
                                        )}
                                        name={name}
                                      />
                                    )}
                                  </For>
                                </ComboboxList>
                              </ComboboxContent>
                            </Combobox>
                            <TooltipContent>
                              Apply saved group{" "}
                              <ShortcutKbd
                                label={savedGroupsHotkeyDisplay()}
                                parts={savedGroupsHotkeyDisplayParts()}
                              />
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  }
                >
                  {(edit) => (
                    <div class="account-manager__toolbar-field account-manager__group-edit-field">
                      <Show
                        when={edit().mode === "create"}
                        fallback={
                          <>
                            <span class="account-manager__group-edit-label">
                              Editing group
                            </span>
                            <div class="account-manager__group-edit-context">
                              <OverflowText as="strong" text={edit().name} />
                              <span>
                                {selectedAccountCount()}{" "}
                                {pluralize(selectedAccountCount(), "account")}
                              </span>
                            </div>
                          </>
                        }
                      >
                        <Label for="account-manager-new-group-name">
                          Group name
                        </Label>
                        <Input
                          aria-describedby={
                            groupMemberEditNameError()
                              ? GROUP_MEMBER_NAME_ERROR_ID
                              : undefined
                          }
                          aria-invalid={
                            groupMemberEditNameError() ? "true" : undefined
                          }
                          fullWidth
                          id="account-manager-new-group-name"
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" || event.isComposing) {
                              return;
                            }

                            event.preventDefault();
                            void handleSaveGroupMemberEdit();
                          }}
                          onInput={(event) =>
                            setGroupMemberEditName(event.currentTarget.value)
                          }
                          ref={(element) => {
                            groupNameInput = element;
                          }}
                          size="lg"
                          value={edit().name}
                        />
                        <Show when={groupMemberEditNameError()}>
                          {(message) => (
                            <small
                              class="account-manager__field-error"
                              id={GROUP_MEMBER_NAME_ERROR_ID}
                            >
                              {message()}
                            </small>
                          )}
                        </Show>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>

              <div
                class="account-list"
                aria-busy={!stateLoaded()}
                aria-live="polite"
              >
                <Show
                  when={stateLoaded()}
                  fallback={
                    <Show when={initialLoadingVisible()}>
                      <div class="account-list__loading" role="status">
                        <Spinner
                          class="account-list__loading-spinner"
                          size="sm"
                        />
                        <span>Loading accounts...</span>
                      </div>
                    </Show>
                  }
                >
                  <Show
                    when={filteredAccounts().length > 0}
                    fallback={
                      <Empty class="account-list__empty">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <Icon
                              icon={
                                accounts().length === 0 ? "user_plus" : "search"
                              }
                            />
                          </EmptyMedia>
                          <EmptyTitle>
                            {accounts().length === 0
                              ? "No accounts yet"
                              : "No accounts found"}
                          </EmptyTitle>
                          <EmptyDescription>
                            {accounts().length === 0
                              ? "Add an account to get started."
                              : `No accounts match “${searchQuery().trim()}”.`}
                          </EmptyDescription>
                        </EmptyHeader>
                        <Show when={accounts().length > 0}>
                          <EmptyContent>
                            <Button
                              onClick={clearAccountSearch}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              Clear search
                            </Button>
                          </EmptyContent>
                        </Show>
                      </Empty>
                    }
                  >
                    <div class="account-list__results">
                      <For each={filteredAccounts()}>
                        {(account) => {
                          let accountActionsTrigger:
                            | HTMLButtonElement
                            | undefined;
                          const [
                            accountActionsSource,
                            setAccountActionsSource,
                          ] = createSignal<"button" | "context" | null>(null);
                          const [
                            accountActionsAnchorPoint,
                            setAccountActionsAnchorPoint,
                          ] = createSignal<{
                            readonly x: number;
                            readonly y: number;
                          } | null>(null);
                          const accountActionsAvailable = () =>
                            groupMemberEdit() === null && !busy();

                          createEffect(() => {
                            if (!accountActionsAvailable()) {
                              setAccountActionsSource(null);
                              setAccountActionsAnchorPoint(null);
                            }
                          });

                          return (
                            <Card
                              class="account-row"
                              classList={{
                                "account-row--selected": isAccountSelected(
                                  account.username,
                                ),
                              }}
                              on:contextmenu={(event) => {
                                const target = event.target;
                                const identity =
                                  event.currentTarget.querySelector<HTMLElement>(
                                    ".account-identity",
                                  );
                                const isInSelectionStrip =
                                  identity !== null &&
                                  event.clientX <
                                    identity.getBoundingClientRect().left;

                                event.preventDefault();
                                event.stopPropagation();

                                // Keep the leading selection strip and visible identity text inert.
                                if (
                                  !accountActionsAvailable() ||
                                  isInSelectionStrip ||
                                  (target instanceof Element &&
                                    target.closest(
                                      ".account-identity__label, .account-identity__username",
                                    ) !== null)
                                ) {
                                  return;
                                }

                                setAccountActionsAnchorPoint({
                                  x: event.clientX,
                                  y: event.clientY,
                                });
                                setAccountActionsSource("context");
                              }}
                            >
                              <Checkbox
                                class="account-row__select-area"
                                id={`checkbox-${account.username}`}
                                checked={isAccountSelected(account.username)}
                                onChange={(event) =>
                                  toggleSelected(
                                    account.username,
                                    event.currentTarget.checked,
                                  )
                                }
                                size="default"
                                aria-label={
                                  groupMemberEdit() === null
                                    ? `Select ${account.label}`
                                    : groupMemberEdit()?.mode === "create"
                                      ? `Include ${account.label} in new group`
                                      : `Include ${account.label} in ${
                                          groupMemberEdit()?.name ?? "group"
                                        }`
                                }
                              >
                                <AccountIdentity
                                  account={account}
                                  layout="card"
                                />
                              </Checkbox>
                              <Show when={groupMemberEdit() === null}>
                                <div class="account-row__actions">
                                  <MoreActionsMenu
                                    anchorPoint={accountActionsAnchorPoint()}
                                    aria-label={`Account actions for ${account.label}`}
                                    disabled={busy()}
                                    open={accountActionsSource() !== null}
                                    onOpenChange={(open) => {
                                      setAccountActionsSource(
                                        open ? "button" : null,
                                      );
                                      setAccountActionsAnchorPoint(null);
                                    }}
                                    onTriggerElement={(element) => {
                                      accountActionsTrigger = element;
                                    }}
                                    tooltip="Account actions"
                                    tooltipDisabled={
                                      accountActionsSource() === "context"
                                    }
                                  >
                                    <AccountActionMenuItems
                                      menu={
                                        accountActionsSource() === "context"
                                          ? "context"
                                          : "dropdown"
                                      }
                                      script={launchScript()}
                                      onDelete={() =>
                                        setAccountToDelete(account)
                                      }
                                      onEdit={() =>
                                        openEditDialog(
                                          account,
                                          accountActionsTrigger,
                                        )
                                      }
                                      onLaunch={(script) =>
                                        void handleLaunchAccountUsername(
                                          account.username,
                                          script,
                                        )
                                      }
                                    />
                                  </MoreActionsMenu>
                                </div>
                              </Show>
                            </Card>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>

              <Show when={groupMemberEdit()}>
                {(edit) => (
                  <div
                    class="account-manager__group-edit-dock"
                    aria-label={
                      edit().mode === "create"
                        ? "Create group"
                        : `Choose accounts for “${edit().name}”`
                    }
                  >
                    <div class="account-manager__group-edit-summary">
                      <strong aria-live="polite">
                        {selectedAccountCount()}{" "}
                        {pluralize(selectedAccountCount(), "account")}{" "}
                        {edit().mode === "create" ? "selected" : "in group"}
                      </strong>
                      <Show when={groupMemberEditError()}>
                        <span
                          id="account-manager-group-edit-error"
                          role="alert"
                        >
                          {groupMemberEditError()}
                        </span>
                      </Show>
                    </div>
                    <div class="account-manager__group-edit-actions">
                      <Button
                        disabled={busy()}
                        onClick={() =>
                          requestGroupMemberEditExit({ type: "cancel" })
                        }
                        size="lg"
                        type="button"
                        variant="secondary"
                      >
                        Cancel
                      </Button>
                      <Button
                        disabled={
                          busy() ||
                          (edit().mode !== "create" && !groupMemberEditDirty())
                        }
                        loading={busy()}
                        onClick={() => void handleSaveGroupMemberEdit()}
                        size="lg"
                        type="button"
                      >
                        {edit().mode === "create"
                          ? "Create group"
                          : "Save changes"}
                      </Button>
                    </div>
                  </div>
                )}
              </Show>

              <Show when={groupMemberEdit() === null}>
                <div
                  class="account-manager__launch-dock"
                  aria-label="Launch configuration"
                >
                  <div class="account-manager__launch-selection">
                    <strong class="account-manager__launch-selection-count">
                      {selectedAccountCount()} selected
                    </strong>
                    <div class="account-manager__launch-selection-actions">
                      <div class="account-manager__launch-selection-safe-actions">
                        <Button
                          disabled={busy() || selectedAccountCount() === 0}
                          onClick={beginGroupCreate}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          Save as group
                        </Button>
                        <Button
                          disabled={busy() || selectedAccountCount() === 0}
                          onClick={clearSelectedAccounts}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Clear selection
                        </Button>
                      </div>
                      <Button
                        class="account-manager__delete-selected"
                        disabled={busy() || selectedAccountCount() === 0}
                        onClick={() => setRemoveSelectedDialogOpen(true)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {selectedRemoveLabel()}
                      </Button>
                    </div>
                  </div>

                  <div class="account-manager__launch-fields">
                    <div
                      ref={(element) => {
                        serverFieldElement = element;
                      }}
                      class="account-manager__field-container"
                    >
                      <div class="account-manager__label">
                        <span>Login server</span>
                        <Tooltip
                          closeDelay={0}
                          openDelay={ACTION_TOOLTIP_OPEN_DELAY_MS}
                        >
                          <TooltipTrigger
                            asChild={(triggerProps) => (
                              <Button
                                {...(triggerProps({
                                  size: "icon-sm",
                                  variant: "ghost",
                                  "aria-label": "Refresh servers",
                                  onClick: () => void handleRefreshServers(),
                                  disabled:
                                    serversLoading() ||
                                    serverRefreshCoolingDown(),
                                } as ButtonProps) as ButtonProps)}
                              >
                                <Icon icon="refresh_cw" class="button__icon" />
                              </Button>
                            )}
                          />
                          <TooltipContent>Refresh servers</TooltipContent>
                        </Tooltip>
                        <Show when={launchCapacityWarning()}>
                          {(warning) => (
                            <Tooltip
                              closeDelay={0}
                              openDelay={ACTION_TOOLTIP_OPEN_DELAY_MS}
                              positioning={{ placement: "top" }}
                              unmountOnExit
                            >
                              <TooltipTrigger
                                asChild={(triggerProps) => (
                                  <span
                                    {...triggerProps({
                                      class:
                                        "account-manager__capacity-warning",
                                      role: "status",
                                      tabIndex: 0,
                                    })}
                                  >
                                    <Icon
                                      icon="triangle_alert"
                                      class="account-manager__capacity-warning-icon"
                                      aria-hidden="true"
                                    />
                                    <span>{warning().label}</span>
                                  </span>
                                )}
                              />
                              <TooltipContent>
                                {warning().message}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </Show>
                      </div>
                      <Tooltip
                        closeDelay={0}
                        disabled={serverComboboxOpen()}
                        open={loginServerTooltipOpen()}
                        openDelay={FIELD_TOOLTIP_OPEN_DELAY_MS}
                        unmountOnExit
                        onOpenChange={(details) =>
                          setLoginServerTooltipOpen(
                            details.open && !serverComboboxOpen(),
                          )
                        }
                      >
                        <Combobox
                          class="account-manager__server-field account-manager__field account-manager__server-combobox"
                          value={[launchServer() || NO_SERVER_VALUE]}
                          disabled={serversLoading() || serverError() !== ""}
                          inputBehavior="autohighlight"
                          open={serverComboboxOpen()}
                          openOnClick
                          positioning={{
                            fitViewport: true,
                            hideWhenDetached: true,
                            sameWidth: false,
                          }}
                          unmountOnExit
                          onOpenChange={(details) => {
                            if (details.open) {
                              setLoginServerTooltipOpen(false);
                            }
                            setServerComboboxOpen(details.open);
                            setServerSearchQuery("");
                            setServerInputValue(launchServer());
                            if (!details.open) {
                              replaceServerInputOnEdit = false;
                            }
                          }}
                          onValueChange={(details) => {
                            const value = details.value[0] ?? NO_SERVER_VALUE;
                            const nextLaunchServer =
                              value === NO_SERVER_VALUE ? "" : value;
                            writeStoredAccountLoginServerPreference(
                              nextLaunchServer === ""
                                ? { type: "none" }
                                : { type: "server", name: nextLaunchServer },
                            );
                            setLaunchServer(nextLaunchServer);
                            setServerInputValue(nextLaunchServer);
                            setServerSearchQuery("");
                            setServerSelectionInitialized(true);
                          }}
                        >
                          <TooltipTrigger
                            asChild={(triggerProps) => (
                              <ComboboxInput
                                {...(triggerProps({
                                  ref: (element) => {
                                    serverComboboxInput = element;
                                  },
                                  "aria-label": "Login server",
                                  "aria-keyshortcuts":
                                    loginServerAriaKeyshortcuts(),
                                  classList: {
                                    "account-manager__server-input--settling":
                                      serversLoading() ||
                                      serverSelectionSettling(),
                                    "account-manager__server-input--overlaid":
                                      serverOverlaySelection() !== undefined,
                                  },
                                  placeholder: "Choose server...",
                                  showClear: false,
                                  size: "lg",
                                  triggerProps: {
                                    onPointerDown: () => {
                                      replaceServerInputOnEdit = true;
                                    },
                                  },
                                  value: serverInputValue(),
                                  onInput: (event) => {
                                    replaceServerInputOnEdit = false;
                                    const value = event.currentTarget.value;
                                    setServerInputValue(value);
                                    setServerSearchQuery(value);
                                  },
                                  onKeyDown: (event) => {
                                    const replacesCurrentValue =
                                      replaceServerInputOnEdit &&
                                      !event.isComposing &&
                                      !event.altKey &&
                                      !event.ctrlKey &&
                                      !event.metaKey &&
                                      (event.key === "Backspace" ||
                                        event.key === "Delete" ||
                                        event.key.length === 1);
                                    if (replacesCurrentValue) {
                                      // Ark may move the caret after opening, so select immediately before the native edit.
                                      event.currentTarget.select();
                                      replaceServerInputOnEdit = false;
                                    } else if (
                                      event.key === "ArrowLeft" ||
                                      event.key === "ArrowRight" ||
                                      event.key === "Home" ||
                                      event.key === "End"
                                    ) {
                                      replaceServerInputOnEdit = false;
                                    }

                                    if (event.key !== "Escape") {
                                      return;
                                    }

                                    replaceServerInputOnEdit = false;
                                    setServerSearchQuery("");
                                    setServerInputValue(
                                      selectedServerInputValue(),
                                    );
                                    event.currentTarget.blur();
                                  },
                                  onPointerDown: () => {
                                    replaceServerInputOnEdit =
                                      !serverComboboxOpen() &&
                                      serverOverlaySelection() !== undefined;
                                  },
                                  onFocus: () => {
                                    setServerInputFocused(true);
                                    setServerInputValue(launchServer());
                                  },
                                  onBlur: () => {
                                    replaceServerInputOnEdit = false;
                                    setServerInputFocused(false);
                                    if (!serverComboboxOpen()) {
                                      setServerSearchQuery("");
                                      setServerInputValue(launchServer());
                                    }
                                  },
                                } satisfies ComboboxInputProps as unknown as Parameters<
                                  typeof triggerProps
                                >[0]) as unknown as ComboboxInputProps)}
                              >
                                <Show when={serverOverlaySelection()}>
                                  {(server) => (
                                    <span
                                      aria-hidden="true"
                                      class="account-manager__server-overlay"
                                    >
                                      {launchServer()}
                                      <Show when={!serverComboboxOpen()}>
                                        <span class="account-manager__server-overlay-meta">
                                          {serverMeta(server())}
                                        </span>
                                        <Show
                                          when={serverPingDisplayState(
                                            server(),
                                          )}
                                        >
                                          {(ping) => (
                                            <span
                                              class={`account-manager__server-overlay-ping account-server-ping account-server-ping--${ping().quality}`}
                                            >
                                              {ping().label}
                                            </span>
                                          )}
                                        </Show>
                                      </Show>
                                    </span>
                                  )}
                                </Show>
                              </ComboboxInput>
                            )}
                          />
                          <ComboboxContent class="account-manager__server-content">
                            <Show
                              when={
                                !showNoServerOption() &&
                                filteredServerOptions().length === 0
                              }
                            >
                              <ComboboxEmpty>No matching servers</ComboboxEmpty>
                            </Show>
                            <ComboboxList>
                              <Show when={showNoServerOption()}>
                                <ComboboxItem
                                  value={NO_SERVER_VALUE}
                                  label="None"
                                >
                                  None
                                </ComboboxItem>
                              </Show>
                              <For each={filteredServerOptions()}>
                                {(server) => {
                                  const pingDisplay = () =>
                                    serverPingDisplayState(server);

                                  return (
                                    <ComboboxItem
                                      value={server.name}
                                      label={serverDisplayLabel(
                                        server,
                                        server.name,
                                      )}
                                      disabled={!server.online}
                                    >
                                      <span
                                        class={`account-server-option account-server-option--${serverAvailability(
                                          server,
                                        )}`}
                                      >
                                        <span class="account-server-option__name">
                                          {server.name}
                                        </span>
                                        <span class="account-server-option__metrics">
                                          <span class="account-server-option__meta">
                                            {serverMeta(server)}
                                          </span>
                                          <Show when={pingDisplay()}>
                                            {(ping) => (
                                              <span
                                                class={`account-server-option__ping account-server-ping account-server-ping--${ping().quality}`}
                                              >
                                                {ping().label}
                                              </span>
                                            )}
                                          </Show>
                                        </span>
                                      </span>
                                    </ComboboxItem>
                                  );
                                }}
                              </For>
                            </ComboboxList>
                          </ComboboxContent>
                        </Combobox>
                        <TooltipContent>
                          Choose login server{" "}
                          <ShortcutKbd
                            label={loginServerHotkeyDisplay()}
                            parts={loginServerHotkeyDisplayParts()}
                          />
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <div class="account-manager__field-container">
                      <div class="account-manager__label">
                        <span>Script</span>
                      </div>
                      <Show
                        when={launchScript() !== null}
                        fallback={
                          <Tooltip
                            closeDelay={0}
                            open={scriptSelectionTooltipOpen()}
                            openDelay={FIELD_TOOLTIP_OPEN_DELAY_MS}
                            unmountOnExit
                            onOpenChange={(details) =>
                              setScriptSelectionTooltipOpen(details.open)
                            }
                          >
                            <TooltipTrigger
                              asChild={(triggerProps) => (
                                <Button
                                  {...(triggerProps({
                                    "aria-describedby": scriptError()
                                      ? SCRIPT_ERROR_ID
                                      : undefined,
                                    "aria-keyshortcuts":
                                      selectScriptAriaKeyshortcuts(),
                                    "aria-label": "Choose script",
                                    class:
                                      "account-manager__script-attachment account-manager__field",
                                    "data-account-script-chooser": "",
                                    disabled: busy(),
                                    onClick: handleLoadScript,
                                    size: "lg",
                                    variant: "outline",
                                  } as ButtonProps) as ButtonProps)}
                                >
                                  <span>Choose script…</span>
                                </Button>
                              )}
                            />
                            <TooltipContent>
                              Choose script{" "}
                              <ShortcutKbd
                                label={selectScriptHotkeyDisplay()}
                                parts={selectScriptHotkeyDisplayParts()}
                              />
                            </TooltipContent>
                          </Tooltip>
                        }
                      >
                        <div class="account-manager__script-attachment account-manager__field">
                          <Tooltip
                            closeDelay={0}
                            open={scriptSelectionTooltipOpen()}
                            openDelay={FIELD_TOOLTIP_OPEN_DELAY_MS}
                            unmountOnExit
                            onOpenChange={(details) =>
                              setScriptSelectionTooltipOpen(details.open)
                            }
                          >
                            <TooltipTrigger
                              asChild={(triggerProps) => (
                                <Button
                                  {...(triggerProps({
                                    "aria-describedby": scriptError()
                                      ? SCRIPT_ERROR_ID
                                      : undefined,
                                    "aria-keyshortcuts":
                                      selectScriptAriaKeyshortcuts(),
                                    "aria-label": "Choose another script",
                                    class:
                                      "account-manager__script-attachment-main",
                                    "data-account-script-chooser": "",
                                    disabled: busy(),
                                    onClick: handleLoadScript,
                                    size: "lg",
                                    variant: "outline",
                                  } as ButtonProps) as ButtonProps)}
                                >
                                  <span class="account-manager__script-attachment-label">
                                    {selectedScriptLabel()}
                                  </span>
                                </Button>
                              )}
                            />
                            <TooltipContent class="account-manager__script-tooltip">
                              <span class="account-manager__script-tooltip-action">
                                <span>Choose another script</span>
                                <ShortcutKbd
                                  label={selectScriptHotkeyDisplay()}
                                  parts={selectScriptHotkeyDisplayParts()}
                                />
                              </span>
                              <span class="account-manager__script-tooltip-path">
                                {selectedScriptPath()}
                              </span>
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip
                            closeDelay={0}
                            openDelay={ACTION_TOOLTIP_OPEN_DELAY_MS}
                          >
                            <TooltipTrigger
                              asChild={(triggerProps) => (
                                <Button
                                  {...(triggerProps({
                                    "aria-label": "Remove selected script",
                                    class:
                                      "account-manager__script-attachment-clear",
                                    disabled: busy(),
                                    onClick: clearLaunchScript,
                                    size: "icon-sm",
                                    variant: "outline",
                                  } as ButtonProps) as ButtonProps)}
                                >
                                  <Icon icon="x" class="button__icon" />
                                </Button>
                              )}
                            />
                            <TooltipContent>Remove script</TooltipContent>
                          </Tooltip>
                        </div>
                      </Show>
                    </div>
                  </div>

                  <div
                    aria-label="Launch selected accounts"
                    class="account-manager__start-actions"
                    data-disabled={
                      !canStartSelected() && !canConfigureLaunchOptions()
                        ? ""
                        : undefined
                    }
                    data-split={useGameTabs() ? "" : undefined}
                    role="group"
                  >
                    <Tooltip
                      closeDelay={0}
                      openDelay={ACTION_TOOLTIP_OPEN_DELAY_MS}
                    >
                      <TooltipTrigger
                        asChild={(triggerProps) => (
                          <Button
                            {...(triggerProps({
                              "aria-keyshortcuts":
                                startSelectedAriaKeyshortcuts(),
                              class: useGameTabs()
                                ? "account-manager__start-button account-manager__start-button--split"
                                : "account-manager__start-button",
                              disabled: !canStartSelected(),
                              onClick: () => void handleLaunch(),
                              size: "lg",
                            } as ButtonProps) as ButtonProps)}
                          >
                            <Icon icon="play" class="button__icon" />
                            Launch
                          </Button>
                        )}
                      />
                      <TooltipContent>
                        {startSelectedTooltip()}{" "}
                        <ShortcutKbd
                          label={startSelectedHotkeyDisplay()}
                          parts={startSelectedHotkeyDisplayParts()}
                        />
                      </TooltipContent>
                    </Tooltip>

                    <Show when={useGameTabs()}>
                      {/* The menu and tooltip share this button. Their shared ID
                          preserves one trigger identity for both floating layers. */}
                      <Tooltip
                        closeDelay={0}
                        disabled={startOptionsOpen()}
                        ids={{ trigger: START_OPTIONS_TRIGGER_ID }}
                        openDelay={ACTION_TOOLTIP_OPEN_DELAY_MS}
                      >
                        <Menu
                          ids={{ trigger: START_OPTIONS_TRIGGER_ID }}
                          open={startOptionsOpen()}
                          positioning={{ gutter: 4, placement: "top-end" }}
                          unmountOnExit
                          onOpenChange={(details) =>
                            setStartOptionsOpen(details.open)
                          }
                        >
                          <MenuTrigger
                            asChild={(menuTriggerProps) => (
                              <TooltipTrigger
                                value="start-options"
                                asChild={(tooltipTriggerProps) => (
                                  <Button
                                    {...(tooltipTriggerProps(
                                      menuTriggerProps({
                                        "aria-label": launchOptionsAriaLabel(),
                                        class:
                                          "account-manager__start-options-button",
                                        disabled: !canConfigureLaunchOptions(),
                                        size: "icon-lg",
                                        type: "button",
                                      } as ButtonProps),
                                    ) as ButtonProps)}
                                  >
                                    <Icon
                                      icon="chevron_down"
                                      class="button__icon"
                                    />
                                  </Button>
                                )}
                              />
                            )}
                          />
                          <MenuContent class="account-manager__start-options-menu">
                            <MenuItem
                              aria-label={
                                accountLaunchMode() === "standard"
                                  ? "Default placement, selected"
                                  : "Default placement"
                              }
                              onSelect={() =>
                                selectAccountLaunchMode("standard")
                              }
                              value="standard"
                            >
                              <span
                                aria-hidden="true"
                                class="account-manager__start-option-indicator"
                              >
                                <Show when={accountLaunchMode() === "standard"}>
                                  <Icon icon="check" />
                                </Show>
                              </span>
                              Default placement
                            </MenuItem>
                            <MenuItem
                              aria-label={
                                accountLaunchMode() === "auto-grid"
                                  ? "Auto grid, selected"
                                  : "Auto grid"
                              }
                              onSelect={() =>
                                selectAccountLaunchMode("auto-grid")
                              }
                              value="auto-grid"
                            >
                              <span
                                aria-hidden="true"
                                class="account-manager__start-option-indicator"
                              >
                                <Show
                                  when={accountLaunchMode() === "auto-grid"}
                                >
                                  <Icon icon="check" />
                                </Show>
                              </span>
                              Auto grid
                            </MenuItem>
                            <MenuSeparator />
                            <MenuCheckboxItem
                              checked={launchInNewWindow()}
                              closeOnSelect={false}
                              onCheckedChange={selectLaunchInNewWindow}
                              value="new-window"
                            >
                              Launch in new window
                            </MenuCheckboxItem>
                          </MenuContent>
                        </Menu>
                        <TooltipContent>
                          {launchOptionsTooltip()}
                        </TooltipContent>
                      </Tooltip>
                    </Show>
                  </div>

                  <Show when={serverError()}>
                    <small class="account-manager__server-error">
                      {serverError()}
                    </small>
                  </Show>
                  <Show when={scriptError()}>
                    <small
                      class="account-manager__script-error"
                      id={SCRIPT_ERROR_ID}
                      role="alert"
                    >
                      {scriptError()}
                    </small>
                  </Show>
                </div>
              </Show>
            </div>
          </section>
        </TabsContent>

        <TabsContent
          class="account-manager__pane account-manager__pane--sessions"
          value="sessions"
        >
          <section
            aria-label="Active sessions"
            class="account-manager__sessions"
          >
            <header class="account-manager__sessions-summary">
              <div>
                <strong>
                  {activeWindowSessions().length}{" "}
                  {pluralize(activeWindowSessions().length, "game session")}
                </strong>
                <span>
                  {activeWindowSessionGroups().length}{" "}
                  {pluralize(activeWindowSessionGroups().length, "game window")}
                </span>
              </div>
              <Show
                when={
                  activeWindowSessions().length > 0 || bulkClosingGameWindows()
                }
              >
                <Button
                  disabled={busy() || closingGameWindowIds().size > 0}
                  loading={bulkClosingGameWindows()}
                  onClick={() => openSessionCloseDialog({ type: "all" })}
                  size="sm"
                  type="button"
                  variant="destructive-outline"
                >
                  {bulkCloseGameWindowsShortLabel()}
                </Button>
              </Show>
            </header>

            <Show
              when={activeWindowSessions().length > 0}
              fallback={
                <Empty class="account-manager__sessions-empty">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Icon icon="monitor" />
                    </EmptyMedia>
                    <EmptyTitle>No active game sessions</EmptyTitle>
                    <EmptyDescription>
                      Launch an account to see its game session here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              }
            >
              <CardFrame class="account-manager__sessions-table-frame">
                <Table class="account-manager__sessions-table" variant="card">
                  <TableCaption class="visually-hidden">
                    Active game sessions grouped by game window
                  </TableCaption>
                  <TableHeader
                    class="account-manager__sessions-table-head"
                    style={{
                      "padding-inline-end": `${sessionsTableScrollbar.gutterWidth()}px`,
                    }}
                  >
                    <TableRow>
                      <TableHead
                        id={SESSION_TABLE_HEADER_IDS.account}
                        scope="col"
                      >
                        Account
                      </TableHead>
                      <TableHead
                        id={SESSION_TABLE_HEADER_IDS.status}
                        scope="col"
                      >
                        Status
                      </TableHead>
                      <TableHead
                        id={SESSION_TABLE_HEADER_IDS.script}
                        scope="col"
                      >
                        Script
                      </TableHead>
                      <TableHead
                        aria-label="Session actions"
                        id={SESSION_TABLE_HEADER_IDS.actions}
                        scope="col"
                      />
                    </TableRow>
                  </TableHeader>
                  <TableBody
                    class="account-manager__sessions-table-body"
                    ref={sessionsTableScrollbar.ref}
                  >
                    <For each={activeWindowSessionGroups()}>
                      {(group) => (
                        <>
                          <Show when={group.shared}>
                            <TableRow class="account-manager__session-group-heading">
                              <TableHead
                                colSpan={4}
                                id={sessionGroupHeaderId(group)}
                              >
                                <span>
                                  {group.sessions.length}{" "}
                                  {pluralize(
                                    group.sessions.length,
                                    "game session",
                                  )}{" "}
                                  in this window
                                </span>
                              </TableHead>
                            </TableRow>
                          </Show>
                          <Index each={group.sessions}>
                            {(session) => {
                              const gameWindowId = () => session().gameWindowId;
                              const isClosing = () =>
                                closingGameWindowIds().has(gameWindowId());
                              const identity = () =>
                                activeWindowAccountIdentity(session());
                              const detailMessage = () =>
                                activeWindowDetailMessage(session());
                              const status = () =>
                                activeWindowStatus(session());
                              const scriptName = () =>
                                activeWindowScriptName(session());

                              return (
                                <TableRow
                                  classList={{
                                    "account-manager__session-row--closing":
                                      isClosing(),
                                  }}
                                >
                                  <TableCell
                                    headers={sessionCellHeaders(
                                      SESSION_TABLE_HEADER_IDS.account,
                                      group,
                                    )}
                                  >
                                    <div class="account-manager__session-identity">
                                      <OverflowText
                                        as="strong"
                                        text={identity().label}
                                      />
                                      <Show when={identity().username}>
                                        {(username) => (
                                          <OverflowText
                                            text={username()}
                                            translate="no"
                                          />
                                        )}
                                      </Show>
                                    </div>
                                  </TableCell>
                                  <TableCell
                                    headers={sessionCellHeaders(
                                      SESSION_TABLE_HEADER_IDS.status,
                                      group,
                                    )}
                                  >
                                    <Badge variant={status().variant}>
                                      <OverflowText
                                        class="account-manager__session-status-label"
                                        text={status().label}
                                      />
                                    </Badge>
                                  </TableCell>
                                  <TableCell
                                    headers={sessionCellHeaders(
                                      SESSION_TABLE_HEADER_IDS.script,
                                      group,
                                    )}
                                  >
                                    <div
                                      classList={{
                                        "account-manager__session-meta": true,
                                        "account-manager__session-meta--with-detail":
                                          detailMessage() !== undefined,
                                      }}
                                    >
                                      <OverflowText
                                        as="strong"
                                        text={scriptName() ?? "No script"}
                                        translate={
                                          scriptName() === undefined
                                            ? "yes"
                                            : "no"
                                        }
                                      />
                                      <Show when={detailMessage()}>
                                        {(message) => (
                                          <span class="account-manager__session-detail">
                                            <OverflowText
                                              class="account-manager__session-detail-text"
                                              text={message()}
                                            />
                                          </span>
                                        )}
                                      </Show>
                                    </div>
                                  </TableCell>
                                  <TableCell
                                    headers={sessionCellHeaders(
                                      SESSION_TABLE_HEADER_IDS.actions,
                                      group,
                                    )}
                                  >
                                    <div class="account-manager__session-actions">
                                      <Button
                                        aria-label={`Show ${identity().label} game window`}
                                        disabled={isClosing()}
                                        onClick={() =>
                                          void handleFocusTrackedGameWindow(
                                            session(),
                                          )
                                        }
                                        size="sm"
                                        type="button"
                                        variant="secondary"
                                      >
                                        <Icon
                                          aria-hidden="true"
                                          class="button__icon"
                                          icon="monitor"
                                        />
                                        Show
                                      </Button>
                                      <Button
                                        aria-label={
                                          "Close " +
                                          identity().label +
                                          " game session"
                                        }
                                        disabled={busy() || isClosing()}
                                        onClick={() =>
                                          openSessionCloseDialog({
                                            session: session(),
                                            type: "single",
                                          })
                                        }
                                        size="sm"
                                        type="button"
                                        variant="destructive-outline"
                                      >
                                        <Icon
                                          aria-hidden="true"
                                          class="button__icon"
                                          icon="trash_2"
                                        />
                                        Close
                                      </Button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              );
                            }}
                          </Index>
                        </>
                      )}
                    </For>
                  </TableBody>
                </Table>
              </CardFrame>
            </Show>
          </section>
        </TabsContent>
      </main>

      <Dialog
        initialFocusEl={groupManagerInitialFocusElement}
        open={groupManagerOpen()}
        onOpenChange={(details) => {
          setGroupManagerOpen(details.open);
          if (!details.open) {
            setGroupManagerFocusTarget(null);
          }
        }}
      >
        <DialogContent class="account-dialog account-group-manager-dialog">
          <DialogHeader>
            <DialogTitle>Saved groups</DialogTitle>
            <DialogDescription>
              Rename groups or change which accounts they include.
            </DialogDescription>
          </DialogHeader>
          <div class="account-group-manager__body">
            <div class="account-group-manager__collection">
              <Show
                when={groupEntries().length > 0}
                fallback={
                  <Empty class="account-group-manager__empty">
                    <EmptyHeader>
                      <EmptyTitle>No saved groups</EmptyTitle>
                      <EmptyDescription>
                        Save a selection to launch it again later.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                }
              >
                <div class="account-group-manager__list">
                  <For each={groupEntries()}>
                    {([name, usernames]) => {
                      return (
                        <div class="account-group-manager__row">
                          <div class="account-group-manager__identity">
                            <OverflowText as="strong" text={name} />
                            <OverflowText
                              text={
                                groupMemberSummary(usernames) || "No accounts"
                              }
                            />
                          </div>
                          <div class="account-group-manager__actions">
                            <Button
                              disabled={busy()}
                              onClick={() => beginGroupMemberEdit(name)}
                              size="sm"
                              type="button"
                              variant="secondary"
                            >
                              Choose accounts
                            </Button>
                            <MoreActionsMenu
                              aria-label={`Group actions for ${name}`}
                              disabled={busy()}
                              tooltip="Group actions"
                              triggerAttributes={{
                                "data-group-actions": "",
                                "data-group-name": name,
                              }}
                            >
                              <MenuItem
                                onSelect={() =>
                                  queueMicrotask(() =>
                                    openRenameGroupDialog(name),
                                  )
                                }
                                value="rename"
                              >
                                Rename
                              </MenuItem>
                              <MenuSeparator />
                              <MenuItem
                                onSelect={() =>
                                  queueMicrotask(() => {
                                    setGroupDeleteError("");
                                    setGroupToDelete(name);
                                  })
                                }
                                value="delete"
                                variant="destructive"
                              >
                                Delete
                              </MenuItem>
                            </MoreActionsMenu>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </div>
          <DialogFooter class="account-group-manager__footer">
            <DialogClose type="button">Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        initialFocusEl={() => groupDialogNameInput ?? null}
        open={groupDialogOpen()}
        onOpenChange={(details) => {
          if (details.open) {
            setGroupDialogOpen(true);
            return;
          }

          closeGroupDialog();
        }}
      >
        <DialogContent class="account-dialog account-group-dialog">
          <DialogHeader>
            <DialogTitle>Rename group</DialogTitle>
          </DialogHeader>

          <form
            class="account-dialog__form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleRenameGroup();
            }}
          >
            <div class="account-dialog__fields">
              <Show when={groupDialogError()}>
                <Alert class="account-dialog__error" variant="error">
                  <AlertDescription>{groupDialogError()}</AlertDescription>
                </Alert>
              </Show>
              <Label
                class="account-dialog__field"
                for="account-manager-group-name"
              >
                <span>Group name</span>
                <Input
                  aria-describedby={
                    groupNameError() ? GROUP_NAME_ERROR_ID : undefined
                  }
                  aria-invalid={groupNameError() ? "true" : undefined}
                  fullWidth
                  id="account-manager-group-name"
                  ref={(element) => {
                    groupDialogNameInput = element;
                  }}
                  size="lg"
                  value={groupForm().name}
                  onInput={(event) =>
                    setGroupFormName(event.currentTarget.value)
                  }
                />
                <Show when={groupNameError()}>
                  {(message) => (
                    <small
                      class="account-manager__field-error"
                      id={GROUP_NAME_ERROR_ID}
                    >
                      {message()}
                    </small>
                  )}
                </Show>
              </Label>
            </div>

            <DialogFooter class="account-group-dialog__footer">
              <DialogClose type="button">Cancel</DialogClose>
              <Button
                size="lg"
                type="submit"
                loading={busy()}
                disabled={busy()}
              >
                Rename group
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={groupToDelete() !== null}
        onOpenChange={(details) => {
          if (!details.open) {
            setGroupToDelete(null);
            setGroupDeleteError("");
          }
        }}
      >
        <AlertDialogContent class="account-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group</AlertDialogTitle>
            <AlertDialogDescription>
              Delete “{groupToDelete()}”? This won’t remove any saved accounts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Show when={groupDeleteError()}>
            <div class="account-delete-dialog__body">
              <Alert class="account-dialog__error" variant="error">
                <AlertDescription>{groupDeleteError()}</AlertDescription>
              </Alert>
            </div>
          </Show>
          <AlertDialogFooter class="account-delete-dialog__footer">
            <AlertDialogCancel disabled={busy()}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy()}
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteGroup();
              }}
              variant="destructive"
            >
              Delete group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={groupMemberEditExitRequest() !== null}
        onOpenChange={(details) => {
          if (!details.open) {
            setGroupMemberEditExitRequest(null);
          }
        }}
      >
        <AlertDialogContent class="account-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {groupMemberEdit()?.mode === "create"
                ? "This new group won’t be created."
                : `Changes to ${groupMemberEdit()?.name ?? "this group"} won’t be saved.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter class="account-delete-dialog__footer">
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmGroupMemberEditExit}
              variant="destructive"
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        initialFocusEl={() => usernameInput ?? null}
        open={dialogOpen()}
        onOpenChange={(details) => {
          if (details.open) {
            setDialogOpen(true);
          } else {
            closeAccountDialog();
          }
        }}
      >
        <DialogContent class="account-dialog">
          <DialogHeader>
            <DialogTitle>
              {dialogMode() === "edit" ? "Edit account" : "Add account"}
            </DialogTitle>
          </DialogHeader>

          <form
            class="account-dialog__form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave({ closeAfterSave: true });
            }}
          >
            <div class="account-dialog__fields">
              <Show when={dialogError()}>
                <Alert class="account-dialog__error" variant="error">
                  <AlertDescription>{dialogError()}</AlertDescription>
                </Alert>
              </Show>
              <Label
                class="account-dialog__field"
                for={ACCOUNT_USERNAME_INPUT_ID}
              >
                <span>Username</span>
                <Input
                  aria-describedby={
                    formErrors().username
                      ? ACCOUNT_USERNAME_ERROR_ID
                      : undefined
                  }
                  aria-invalid={formErrors().username ? "true" : undefined}
                  ref={(element) => {
                    usernameInput = element;
                  }}
                  fullWidth
                  id={ACCOUNT_USERNAME_INPUT_ID}
                  size="lg"
                  value={form().username}
                  onInput={(event) =>
                    setFormField("username", event.currentTarget.value)
                  }
                />
                <Show when={formErrors().username}>
                  {(message) => (
                    <small
                      class="account-manager__field-error"
                      id={ACCOUNT_USERNAME_ERROR_ID}
                    >
                      {message()}
                    </small>
                  )}
                </Show>
              </Label>
              <div class="account-dialog__field">
                <Label for={ACCOUNT_PASSWORD_INPUT_ID}>Password</Label>
                <InputGroup class="account-dialog__password-control" size="lg">
                  <InputGroupInput
                    aria-describedby={
                      formErrors().password
                        ? ACCOUNT_PASSWORD_ERROR_ID
                        : undefined
                    }
                    aria-invalid={formErrors().password ? "true" : undefined}
                    id={ACCOUNT_PASSWORD_INPUT_ID}
                    ref={(element) => {
                      passwordInput = element;
                    }}
                    type={passwordVisible() ? "text" : "password"}
                    value={form().password}
                    onInput={(event) =>
                      setFormField("password", event.currentTarget.value)
                    }
                  />
                  <InputGroupAddon
                    align="inline-end"
                    class="account-dialog__password-addon"
                  >
                    <Tooltip
                      closeDelay={0}
                      openDelay={ACTION_TOOLTIP_OPEN_DELAY_MS}
                    >
                      <TooltipTrigger
                        asChild={(triggerProps) => (
                          <Button
                            {...(triggerProps({
                              "aria-label": passwordVisible()
                                ? "Hide password"
                                : "Show password",
                              "aria-pressed": passwordVisible(),
                              class: "account-dialog__password-button",
                              onClick: () =>
                                setPasswordVisible((visible) => !visible),
                              size: "sm",
                              type: "button",
                              variant: "ghost",
                            } as ButtonProps) as ButtonProps)}
                          >
                            <Icon
                              icon={passwordVisible() ? "eye_off" : "eye"}
                            />
                          </Button>
                        )}
                      />
                      <TooltipContent>
                        {passwordVisible() ? "Hide password" : "Show password"}
                      </TooltipContent>
                    </Tooltip>
                  </InputGroupAddon>
                </InputGroup>
                <Show when={formErrors().password}>
                  {(message) => (
                    <small
                      class="account-manager__field-error"
                      id={ACCOUNT_PASSWORD_ERROR_ID}
                    >
                      {message()}
                    </small>
                  )}
                </Show>
              </div>

              <div class="account-dialog__optional-field">
                <Label class="account-dialog__field">
                  <div class="account-dialog__field-header">
                    <span>Label</span>
                    <span class="account-dialog__field-optional">
                      (optional)
                    </span>
                  </div>
                  <Input
                    fullWidth
                    size="lg"
                    value={form().label === form().username ? "" : form().label}
                    onInput={(event) =>
                      setFormField("label", event.currentTarget.value)
                    }
                  />
                  <small class="account-dialog__field-optional">
                    Uses the username if left blank.
                  </small>
                </Label>
              </div>
            </div>

            <DialogFooter>
              <Show when={dialogMode() === "edit"}>
                <AlertDialog>
                  <AlertDialogTrigger
                    asChild={(triggerProps) => (
                      <Button
                        {...(triggerProps({
                          children: "Remove",
                          disabled: busy(),
                          variant: "destructive-outline",
                        } as ButtonProps) as ButtonProps)}
                      />
                    )}
                  />
                  <AlertDialogContent class="account-dialog">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove account</AlertDialogTitle>
                      <AlertDialogDescription>
                        {confirmRemoveDescription(
                          form().label || form().username,
                        )}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter class="account-delete-dialog__footer">
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => void handleDeleteCurrentAccount()}
                        variant="destructive"
                      >
                        Remove account
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </Show>
              <DialogClose type="button">Cancel</DialogClose>
              <Show when={dialogMode() === "create"}>
                <Button
                  size="lg"
                  variant="outline"
                  type="button"
                  loading={busy()}
                  disabled={busy() || accountFormIncomplete()}
                  onClick={() => void handleSave({ closeAfterSave: false })}
                >
                  Add another
                </Button>
              </Show>
              <Button
                size="lg"
                type="submit"
                loading={busy()}
                disabled={
                  busy() ||
                  (dialogMode() === "create" && accountFormIncomplete())
                }
              >
                {dialogMode() === "edit" ? "Save changes" : "Add account"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removeSelectedDialogOpen()}
        onOpenChange={(details) => setRemoveSelectedDialogOpen(details.open)}
      >
        <AlertDialogContent class="account-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{selectedRemoveLabel()}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRemoveSelectedDescription()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter class="account-delete-dialog__footer">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleRemoveSelected()}
              variant="destructive"
            >
              {selectedRemoveConfirmLabel()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={accountToDelete() !== null}
        onOpenChange={(details) => {
          if (!details.open) {
            setAccountToDelete(null);
          }
        }}
      >
        <AlertDialogContent class="account-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove account</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const acc = accountToDelete();
                return acc ? confirmRemoveDescription(acc.label) : "";
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter class="account-delete-dialog__footer">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const acc = accountToDelete();
                if (acc) {
                  void handleDeleteAccountUsername(acc.username);
                }
                setAccountToDelete(null);
              }}
              variant="destructive"
            >
              Remove account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={sessionCloseDialogOpen()}
        onOpenChange={(details) => setSessionCloseDialogOpen(details.open)}
      >
        <AlertDialogContent class="account-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {sessionCloseRequest()?.type === "all"
                ? bulkCloseGameWindowsLabel()
                : "Close game session"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const request = sessionCloseRequest();
                if (request === null) {
                  return "";
                }

                return request.type === "all"
                  ? closeAllGameWindowsDescription(activeWindowSessions())
                  : closeGameWindowDescription(request.session);
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter class="active-windows-close-dialog__footer">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const request = sessionCloseRequest();
                if (request?.type === "all") {
                  void handleCloseAllTrackedGameWindows();
                } else if (request?.type === "single") {
                  void handleCloseTrackedGameWindows([request.session]);
                }
              }}
              variant="destructive"
            >
              {sessionCloseRequest()?.type === "all"
                ? bulkCloseGameWindowsLabel()
                : "Close game session"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}

/** Connects the fixture-driven Account Manager view to Electron IPC. */
export function App(props: DesktopRendererProps): JSX.Element {
  const desktop = selectDesktopBridge(window.desktop, "account-manager");
  const accounts = desktop.accounts;

  return (
    <AccountManagerView
      callbacks={{
        closeGameWindow: (request) => accounts.closeGameWindow(request),
        closeGameWindows: (gameWindowIds) =>
          accounts.closeGameWindows(gameWindowIds),
        createAccount: (draft) => accounts.createAccount(draft),
        createGroup: (draft) => accounts.createGroup(draft),
        deleteAccount: (username) => accounts.deleteAccount(username),
        deleteAccounts: (usernames) => accounts.deleteAccounts(usernames),
        deleteGroup: (name) => accounts.deleteGroup(name),
        focusGameWindow: (request) => accounts.focusGameWindow(request),
        getServerPings: () => accounts.getServerPings(),
        getServers: () => accounts.getServers(),
        getState: () => accounts.getState(),
        launch: (request) => accounts.launch(request),
        onChanged: (listener) => accounts.onChanged(listener),
        onUseGameTabsChanged: (listener) =>
          desktop.settings.onChanged((settings) =>
            listener(settings.preferences.useGameTabs),
          ),
        refreshServers: () => accounts.refreshServers(),
        selectScript: () => desktop.scripting.selectFile(),
        updateAccount: (username, patch) =>
          accounts.updateAccount(username, patch),
        updateGroup: (name, patch) => accounts.updateGroup(name, patch),
      }}
      fixture={{
        state: emptyState,
        stateLoaded: false,
        useGameTabs: props.initialSettings?.preferences.useGameTabs ?? false,
      }}
      platform={props.platform}
    />
  );
}

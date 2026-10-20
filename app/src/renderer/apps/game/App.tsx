import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icon,
  Input,
  Label,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  TooltipIconButton,
  VisuallyHidden,
} from "@lucent/ui";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";

import {
  selectDesktopBridge,
  type AppPlatform,
} from "../../../shared/desktopBridge";
import {
  shouldDispatchGameViewGroupOptionHotkey,
  type GameViewGroupCommand,
  type GameViewPresentation,
} from "../../../shared/gameViews";
import type {
  AccountGameLaunchPayload,
  AccountSessionLogin,
} from "@lucent/core/accounts";
import {
  DEFAULT_ACCOUNT_SETTINGS,
  type RoomPolicy,
} from "@lucent/core/accountSettings";
import {
  DEFAULT_COMBAT_PROFILE_ID,
  DEFAULT_COMBAT_PROFILE_LIBRARY,
  getCombatProfileById,
  type CombatProfileLibrary,
} from "@lucent/core/combatProfiles";
import type { ScriptFile } from "../../../shared/ipc/scripting";
import type { ScriptReference } from "@lucent/core/scriptPackages";
import {
  normalizeScriptInputValues,
  validateScriptInputValues,
  type ScriptFileReference,
  type ScriptInputField,
  type ScriptInputValues,
  type ScriptInputsDefinition,
} from "@lucent/core/scriptInputs";
import {
  SETTINGS_COMMANDS,
  hotkeyBindingMatchKey,
  readHotkeyBinding,
  type SettingsCommandId,
} from "@lucent/core/hotkeys";
import { hotkeyInputMatchKey } from "../../../shared/hotkeys";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "@lucent/core/settings";
import { Api, type ApiService, flashRuntime as runtime } from "./flash";
import type {
  RenderingMode,
  Settings as FlashSettingsSnapshot,
} from "./flash/contract/Settings";
import { Automation } from "./automation/Automation";
import { Environment } from "./environment/Environment";
import {
  parseAutoAttackTargetPriority,
  type AutoAttackState,
} from "./automation/AutoAttack";
import {
  type AutoReloginLifecycleEvent,
  type AutoReloginState,
} from "./automation/AutoRelogin";
import {
  type AutoZoneState,
  type AutoZoneSupportedMap,
} from "./automation/AutoZone";
import {
  ScriptRunner,
  type ScriptOptionsUpdateResult,
  type ScriptRunHandle,
  type ScriptRunnerStatus,
} from "./scripting/ScriptRunner";
import type { ScriptRuntimeOptions } from "./scripting/ScriptApi";
import {
  formatRoomNumberInput,
  parseRoomNumberInput,
} from "./scripting/roomPolicyInput";
import { prepareScriptStart } from "./scripting/scriptStartPreparation";
import { runScriptEval } from "./scripting/ScriptEvaluator";
import { makeGameViewGroupCommandQueue } from "./groupCommandQueue";
import {
  fatalScriptAlertFromError,
  fatalScriptAlertFromStatus,
  type FatalScriptAlert,
} from "./scripting/fatalAlert";
import { resolveAccountScript } from "./scripting/accountScriptResolution";
import {
  accountScriptLabel,
  accountSessionScriptState,
} from "./scripting/accountScriptStatus";
import { makeAccountSessionTracker } from "./accountSessionTracker";
import { ScriptsDialog, type ScriptOptionsSaveStatus } from "./ScriptsDialog";
import {
  makeScriptQueue,
  type ScriptQueue,
  type ScriptQueueInputRequest,
  type ScriptQueueState,
} from "./scripting/ScriptQueue";
import {
  ScriptInputsErrorAlert,
  type ScriptInputsDialogError,
} from "./ScriptInputsErrorAlert";
import {
  scriptInputDraftFromValues,
  scriptInputFieldLabel,
  scriptInputValuesFromDraft,
  scriptSelectFieldOptions,
  type ScriptInputDraftValue,
  type ScriptInputDraftValues,
} from "./scriptInputForm";
import {
  TopNav,
  type GameTopNavMenu,
  type TopNavRenderingModeOptionItem,
  type TopNavToggleOptionItem,
  type WindowId,
  topNavOptionCommandIds,
  windowCommandIds,
} from "./TopNav";
import { createRandomId } from "../../../shared/randomId";
import { createHotkeyStatus, HotkeyStatus } from "./HotkeyStatus";
import { ScriptDialogHost } from "./ScriptDialogHost";
import {
  ScriptDialogs,
  type ScriptDialogRequest,
  type ScriptDialogResponse,
} from "./scripting/ScriptDialogs";

const desktop = selectDesktopBridge(window.desktop, "game");

const respondToScriptDialog = (response: ScriptDialogResponse): void => {
  runtime.runFork(
    Effect.gen(function* () {
      const dialogs = yield* ScriptDialogs;
      yield* dialogs.respond(response);
    }),
  );
};

type GameLoadState =
  | Readonly<{ phase: "loading" | "delayed"; progress: number }>
  | Readonly<{ phase: "loaded"; progress: 100 }>;

type DebugPanelFrame = {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
};

type FlashRuntimeServices = Awaited<ReturnType<typeof collectFlashServices>>;

type DebugEvalLogLevel = "debug" | "error" | "info" | "log" | "warn";
type DebugEvalMode = "flash" | "script";

interface DebugEvalLogEntry {
  readonly arguments: readonly unknown[];
  readonly level: DebugEvalLogLevel;
}

interface DebugEvalExecution {
  readonly logs: readonly DebugEvalLogEntry[];
  readonly result: unknown;
}

const DEBUG_EVAL_OUTPUT_LIMIT = 2000;
const DEBUG_PANEL_MARGIN_PX = 12;
const DEBUG_PANEL_MIN_WIDTH_PX = 320;
const DEBUG_PANEL_MIN_HEIGHT_PX = 220;
const DEBUG_PANEL_DEFAULT_WIDTH_PX = 432;
const DEBUG_PANEL_DEFAULT_HEIGHT_PX = 360;

const DEFAULT_FLASH_DEBUG_SOURCE = `return yield* services.player.getCell();`;
const DEFAULT_SCRIPT_DEBUG_SOURCE = `return yield* api.player.getCell();`;
const AUTO_RELOGIN_DEFAULT_DELAY_SECONDS = "3";
const PLAYER_READY_RETRY_INTERVAL_MS = 250;
const PLAYER_READY_RETRY_TIMEOUT_MS = 10_000;
const GAME_LOAD_RECOVERY_DELAY_MS = 10_000;
const ACCOUNT_LAUNCH_GAME_LOAD_TIMEOUT_MS = 30_000;
const INACTIVE_FOCUSED_LAYOUT_FRAME_RATE_LIMIT = 2;
const INACTIVE_GRID_VIEW_FRAME_RATE_LIMIT = 8;
const SCRIPT_OPTIONS_SAVING_DELAY_MS = 500;

const gameViewFrameRateLimit = (
  presentation: GameViewPresentation,
): number | null => {
  if (presentation.active && presentation.windowActive) return null;
  return presentation.layout === "grid"
    ? INACTIVE_GRID_VIEW_FRAME_RATE_LIMIT
    : INACTIVE_FOCUSED_LAYOUT_FRAME_RATE_LIMIT;
};

const wait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, delayMs));

type ScriptTimingOperation =
  | "catalog-load"
  | "catalog-start"
  | "group-start"
  | "loaded-start"
  | "required-input-start";

interface ScriptTimingTrace {
  readonly id: string;
  readonly operation: ScriptTimingOperation;
  readonly startedAt: number;
}

let nextScriptTimingTraceId = 0;

const roundedDuration = (durationMs: number): number =>
  Math.round(durationMs * 10) / 10;

const reportScriptTiming = (
  trace: ScriptTimingTrace,
  event: "begin" | "complete" | "stage",
  data: Readonly<Record<string, unknown>> = {},
): void => {
  if (!desktop.debug) return;
  console.info("[script:timing]", {
    event,
    operation: trace.operation,
    traceId: trace.id,
    ...data,
  });
};

const beginScriptTiming = (
  operation: ScriptTimingOperation,
  data: Readonly<Record<string, unknown>> = {},
): ScriptTimingTrace => {
  const trace: ScriptTimingTrace = {
    id: `script-${Date.now().toString(36)}-${(nextScriptTimingTraceId += 1)}`,
    operation,
    startedAt: performance.now(),
  };
  reportScriptTiming(trace, "begin", data);
  return trace;
};

const timeScriptStage = async <Result,>(
  trace: ScriptTimingTrace,
  stage: string,
  run: () => Promise<Result>,
): Promise<Result> => {
  const startedAt = performance.now();
  try {
    const result = await run();
    reportScriptTiming(trace, "stage", {
      durationMs: roundedDuration(performance.now() - startedAt),
      outcome: "completed",
      stage,
    });
    return result;
  } catch (cause) {
    reportScriptTiming(trace, "stage", {
      durationMs: roundedDuration(performance.now() - startedAt),
      error: formatEvalError(cause),
      outcome: "failed",
      stage,
    });
    throw cause;
  }
};

const completeScriptTiming = (
  trace: ScriptTimingTrace,
  outcome: "completed" | "failed",
  cause?: unknown,
): void => {
  reportScriptTiming(trace, "complete", {
    durationMs: roundedDuration(performance.now() - trace.startedAt),
    ...(cause === undefined ? {} : { error: formatEvalError(cause) }),
    outcome,
  });
};

const DEFAULT_FLASH_SETTINGS: FlashSettingsSnapshot = {
  animationsEnabled: true,
  antiCounterEnabled: true,
  collisionsEnabled: true,
  customGuild: "",
  customGuildConfigured: false,
  customName: "",
  customNameConfigured: false,
  deathAdsVisible: true,
  enemyMagnetEnabled: false,
  frameRate: 24,
  infiniteRangeEnabled: false,
  otherPlayersVisible: true,
  provokeCellEnabled: false,
  renderingMode: "full",
  skipCutscenesEnabled: false,
  walkSpeed: 8,
};
const DEFAULT_CELL = "Enter";
const DEFAULT_PAD = "Spawn";
const DEFAULT_PADS = [
  "Spawn",
  "Center",
  "Left",
  "Right",
  "Top",
  "Bottom",
  "Up",
  "Down",
] as const;
const DEFAULT_CELLS = [] as const;

const accountLaunchLifecycleMessage = (
  event: AutoReloginLifecycleEvent,
  server: string | undefined,
): string => {
  if (event.message !== undefined) {
    if (event.message.startsWith("Waiting for ")) return event.message;
    return event.attemptsRemaining > 0
      ? `Retrying login (${event.attemptsRemaining} left): ${event.message}`
      : event.message;
  }

  switch (event.step) {
    case "connect":
      return server === undefined || server === ""
        ? "Connecting..."
        : `Connecting to ${server}...`;
    case "login":
      return "Logging in...";
    case "ready":
      return "Waiting for player...";
  }
};

const accountLaunchLoginState = (
  event: AutoReloginLifecycleEvent,
  server: string | undefined,
): AccountSessionLogin => {
  const message = accountLaunchLifecycleMessage(event, server);
  switch (event.step) {
    case "connect":
      return {
        attemptsRemaining: event.attemptsRemaining,
        message,
        ...(server === undefined || server === "" ? {} : { server }),
        state: "selecting-server",
      };
    case "login":
      return {
        attemptsRemaining: event.attemptsRemaining,
        message,
        state: "authenticating",
      };
    case "ready":
      return {
        attemptsRemaining: event.attemptsRemaining,
        message,
        state: "waiting-for-player",
      };
  }
};

interface TravelOptions {
  readonly currentCell: string;
  readonly currentPad: string;
  readonly mapCells: readonly string[];
  readonly mapPads: readonly string[];
}

type GameHotkeyHandler = () => void | Promise<void>;

interface GameHotkeyCommand {
  readonly commandId: SettingsCommandId;
  readonly handler: GameHotkeyHandler;
}

type ConfirmedToggleOptionItem = Omit<
  TopNavToggleOptionItem,
  "onCheckedChange"
> & {
  readonly hotkeyStatusLabel: string;
  readonly onCheckedChange: (checked: boolean) => Promise<boolean | undefined>;
};

type GameTopNavOptionItem =
  | ConfirmedToggleOptionItem
  | TopNavRenderingModeOptionItem;

const formatHotkeyToggleStatus = (label: string, checked: boolean): string =>
  `${label}: ${checked ? "On" : "Off"}`;

const renderingModeStatusLabels: Record<RenderingMode, string> = {
  full: "Full",
  "interface-only": "Interface only",
  minimal: "Minimal",
};

const formatHotkeyRenderingModeStatus = (mode: RenderingMode): string =>
  `Rendering mode: ${renderingModeStatusLabels[mode]}`;

const windowIdsByCommandId = new Map<SettingsCommandId, WindowId>(
  Object.entries(windowCommandIds).flatMap(([id, commandId]) =>
    commandId === undefined ? [] : [[commandId, id as WindowId] as const],
  ),
);

const writeDocumentLoaded = (loaded: boolean): void => {
  document.documentElement.dataset["loaded"] = loaded ? "true" : "false";
};

const writeTopNavHidden = (hidden: boolean): void => {
  document.documentElement.toggleAttribute("data-topnav-hidden", hidden);
};

const writeRenderingMinimal = (minimal: boolean): void => {
  document.documentElement.toggleAttribute("data-rendering-minimal", minimal);
};

const isEditableHotkeyTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) {
    return false;
  }

  const editable = target.closest("input, textarea, select, [contenteditable]");
  if (editable === null) {
    return false;
  }

  return editable.getAttribute("contenteditable") !== "false";
};

const isFlashTextFieldFocused = (): boolean => {
  try {
    return window.swf["flash.isTextFieldFocused"]();
  } catch {
    return false;
  }
};

const getAutoAttackConfiguredProfileLabel = (
  library: CombatProfileLibrary,
  selectedProfileId: string,
): string => {
  const profile = getCombatProfileById(library, selectedProfileId);
  return profile.label;
};

const getAvailableAutoAttackProfileId = (
  library: CombatProfileLibrary,
  profileId: string,
): string =>
  library.profiles.some((profile) => profile.id === profileId)
    ? profileId
    : DEFAULT_COMBAT_PROFILE_ID;

const EffectFunction = Function as unknown as new (
  ...args: string[]
) => (
  services: FlashRuntimeServices,
  effect: typeof Effect,
  console: Console,
) => Effect.Effect<unknown, unknown, never>;

const collectFlashServices = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const api = yield* Api;
      const environment = yield* Environment;

      return {
        ...api,
        environment,
        outfits: api.player.outfits,
      };
    }),
  );

const formatEvalValue = (value: unknown): string => {
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const formatEvalError = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : String(error);

const formatEvalConsole = (entries: readonly DebugEvalLogEntry[]): string =>
  entries
    .map((entry) => {
      const values = entry.arguments.map((value) => {
        if (value instanceof Error) return formatEvalError(value);
        return typeof value === "string"
          ? JSON.stringify(value)
          : formatEvalValue(value);
      });
      return `[${entry.level}] ${values.join(" ")}`;
    })
    .join("\n");

const truncateOutput = (value: string): string =>
  value.length <= DEBUG_EVAL_OUTPUT_LIMIT
    ? value
    : `${value.slice(0, DEBUG_EVAL_OUTPUT_LIMIT)}...`;

const formatDelaySeconds = (delayMs: number): string =>
  String(Math.max(0, delayMs / 1_000));

const parseDelayMs = (delaySeconds: string): number | null => {
  const seconds = Number.parseFloat(delaySeconds);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : null;
};

const scriptStatusLabel = (
  loaded: ScriptFile | null,
  status: ScriptRunnerStatus,
): string => {
  if (status.state === "starting") {
    return `Starting ${status.name}`;
  }

  if (status.state === "running") {
    return `Running ${status.name}`;
  }

  if (status.state === "stopping") {
    return `Stopping ${status.name}`;
  }

  if (status.state === "waiting-to-restart") {
    return `Waiting to restart ${status.name}`;
  }

  if (status.state === "failed") {
    return `Failed: ${status.message}`;
  }

  if (status.state === "completed") {
    return `Completed ${status.name}`;
  }

  if (status.state === "stopped") {
    return status.reason === undefined
      ? "Stopped"
      : `Stopped: ${status.reason}`;
  }

  return loaded === null ? "No script loaded" : `Loaded ${loaded.name}`;
};

type ScriptInputsDialogMode =
  | "account-required"
  | "manual"
  | "queue-add"
  | "queue-edit"
  | "queue-preflight"
  | "required";

const isRequiredScriptInputsDialog = (mode: ScriptInputsDialogMode): boolean =>
  mode === "account-required" || mode === "required";

interface PendingQueueInputDialog {
  readonly abort: () => void;
  readonly reopenScriptsDialog: boolean;
  readonly resolve: (values: ScriptInputValues | null) => void;
}

interface PendingAccountInputDialog {
  readonly abort: () => void;
  readonly resolve: (values: ScriptInputValues | null) => void;
}

interface PendingQueueReplacementConfirmation {
  readonly abort: () => void;
  readonly resolve: (confirmed: boolean) => void;
}

const clampPanelFrame = (frame: DebugPanelFrame): DebugPanelFrame => {
  const maxWidth = Math.max(
    DEBUG_PANEL_MIN_WIDTH_PX,
    window.innerWidth - DEBUG_PANEL_MARGIN_PX * 2,
  );
  const maxHeight = Math.max(
    DEBUG_PANEL_MIN_HEIGHT_PX,
    window.innerHeight - DEBUG_PANEL_MARGIN_PX * 2,
  );
  const width = Math.min(
    Math.max(frame.width, DEBUG_PANEL_MIN_WIDTH_PX),
    maxWidth,
  );
  const height = Math.min(
    Math.max(frame.height, DEBUG_PANEL_MIN_HEIGHT_PX),
    maxHeight,
  );

  return {
    height,
    width,
    x: Math.min(
      Math.max(frame.x, DEBUG_PANEL_MARGIN_PX),
      Math.max(
        DEBUG_PANEL_MARGIN_PX,
        window.innerWidth - width - DEBUG_PANEL_MARGIN_PX,
      ),
    ),
    y: Math.min(
      Math.max(frame.y, DEBUG_PANEL_MARGIN_PX),
      Math.max(
        DEBUG_PANEL_MARGIN_PX,
        window.innerHeight - height - DEBUG_PANEL_MARGIN_PX,
      ),
    ),
  };
};

const createInitialPanelFrame = (): DebugPanelFrame => {
  const width = Math.min(
    DEBUG_PANEL_DEFAULT_WIDTH_PX,
    Math.max(
      DEBUG_PANEL_MIN_WIDTH_PX,
      window.innerWidth - DEBUG_PANEL_MARGIN_PX * 2,
    ),
  );
  const height = Math.min(
    DEBUG_PANEL_DEFAULT_HEIGHT_PX,
    Math.max(
      DEBUG_PANEL_MIN_HEIGHT_PX,
      window.innerHeight - DEBUG_PANEL_MARGIN_PX * 2,
    ),
  );

  return clampPanelFrame({
    height,
    width,
    x: window.innerWidth - width - DEBUG_PANEL_MARGIN_PX,
    y: window.innerHeight - height - DEBUG_PANEL_MARGIN_PX,
  });
};

const makeDebugConsole = (logs: DebugEvalLogEntry[]): Console => {
  const capture =
    (level: DebugEvalLogLevel) =>
    (...args: unknown[]) => {
      logs.push({ arguments: args, level });
      console[level](...args);
    };

  return Object.assign(Object.create(console) as Console, {
    debug: capture("debug"),
    error: capture("error"),
    info: capture("info"),
    log: capture("log"),
    warn: capture("warn"),
  });
};

const runFlashEval = (
  source: string,
  signal: AbortSignal,
): Promise<DebugEvalExecution> =>
  collectFlashServices().then(async (services) => {
    const logs: DebugEvalLogEntry[] = [];
    const debugConsole = makeDebugConsole(logs);
    const compileInternalEval = new EffectFunction(
      "services",
      "Effect",
      "console",
      `"use strict";
return Effect.gen(function* debugInternalEval() {
${source}
});`,
    );

    const result = await runtime.runPromise(
      compileInternalEval(services, Effect, debugConsole),
      { signal },
    );
    return { logs, result };
  });

const runScriptDebugEval = async (
  source: string,
  signal: AbortSignal,
): Promise<DebugEvalExecution> => {
  const logs: DebugEvalLogEntry[] = [];
  const result = await runtime.runPromise(
    runScriptEval(source, makeDebugConsole(logs)),
    { signal },
  );
  return { logs, result };
};

const runDebugEval = (
  mode: DebugEvalMode,
  source: string,
  signal: AbortSignal,
): Promise<DebugEvalExecution> =>
  mode === "script"
    ? runScriptDebugEval(source, signal)
    : runFlashEval(source, signal);

const readTravelOptions = (): Promise<TravelOptions> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const { map, player } = yield* Api;
      const [mapCells, mapPads, currentCell, currentPad] = yield* Effect.all([
        map.getCells(),
        map.getCellPads(),
        player.getCell(),
        player.getPad(),
      ]);

      return {
        currentCell,
        currentPad,
        mapCells,
        mapPads,
      };
    }),
  );

/** Reads identity only from a ready projected self, never cached credentials. */
const readReadyPlayerUsername = (): Promise<string | undefined> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const { player } = yield* Api;
      if (!(yield* player.isReady())) return undefined;

      const current = yield* player.get();
      const username = current?.username.trim();
      return username === undefined || username === "" ? undefined : username;
    }),
  );

function DevDebugEvaluator(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [mode, setMode] = createSignal<DebugEvalMode>("script");
  const [flashSource, setFlashSource] = createSignal(
    DEFAULT_FLASH_DEBUG_SOURCE,
  );
  const [scriptSource, setScriptSource] = createSignal(
    DEFAULT_SCRIPT_DEBUG_SOURCE,
  );
  const [status, setStatus] = createSignal("Idle");
  const [output, setOutput] = createSignal("");
  const [consoleOutput, setConsoleOutput] = createSignal("");
  const [resultOutput, setResultOutput] = createSignal("");
  const [copyableOutput, setCopyableOutput] = createSignal<string | null>(null);
  const [outputCopied, setOutputCopied] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [panelFrame, setPanelFrame] = createSignal<DebugPanelFrame>(
    createInitialPanelFrame(),
  );
  let panelElement: HTMLDivElement | undefined;
  let panelResizeObserver: ResizeObserver | undefined;
  let cleanupPanelPointer: (() => void) | undefined;
  let outputCopiedTimer: number | undefined;
  let evalController: AbortController | undefined;

  const currentSource = createMemo(() =>
    mode() === "script" ? scriptSource() : flashSource(),
  );

  const clearOutput = () => {
    setOutput("");
    setConsoleOutput("");
    setResultOutput("");
    setCopyableOutput(null);
    setOutputCopied(false);
  };

  const selectMode = (nextMode: DebugEvalMode) => {
    if (running() || nextMode === mode()) {
      return;
    }

    setMode(nextMode);
    setStatus("Idle");
    clearOutput();
  };

  onMount(() => {
    const handleResize = () => {
      setPanelFrame(clampPanelFrame);
    };

    panelResizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      const borderBoxSize = entry?.borderBoxSize[0];
      const width =
        borderBoxSize === undefined
          ? panelElement?.offsetWidth
          : borderBoxSize.inlineSize;
      const height =
        borderBoxSize === undefined
          ? panelElement?.offsetHeight
          : borderBoxSize.blockSize;

      if (width === undefined || height === undefined) {
        return;
      }

      setPanelFrame((frame) =>
        clampPanelFrame({
          ...frame,
          height: Math.round(height),
          width: Math.round(width),
        }),
      );
    });

    window.addEventListener("resize", handleResize);
    onCleanup(() => {
      cleanupPanelPointer?.();
      if (outputCopiedTimer !== undefined) {
        window.clearTimeout(outputCopiedTimer);
      }
      evalController?.abort();
      panelResizeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
    });
  });

  createEffect(() => {
    const element = panelElement;
    const observer = panelResizeObserver;
    if (!open() || element === undefined || observer === undefined) {
      return;
    }

    observer.observe(element);
    onCleanup(() => {
      observer.unobserve(element);
    });
  });

  const markOutputCopied = () => {
    if (outputCopiedTimer !== undefined) {
      window.clearTimeout(outputCopiedTimer);
    }

    setOutputCopied(true);
    outputCopiedTimer = window.setTimeout(() => {
      setOutputCopied(false);
      outputCopiedTimer = undefined;
    }, 900);
  };

  const copyOutput = async () => {
    const value = copyableOutput();
    if (value === null) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setStatus("Result copied");
      markOutputCopied();
    } catch {
      setStatus("Copy failed");
    }
  };

  const runEval = () => {
    if (running()) {
      return;
    }

    const evalMode = mode();
    const source = currentSource().trim();
    if (source === "") {
      setStatus("No code to evaluate");
      clearOutput();
      return;
    }

    const controller = new AbortController();
    evalController = controller;
    setRunning(true);
    setStatus(`Running ${evalMode} eval`);
    clearOutput();

    void runDebugEval(evalMode, source, controller.signal)
      .then((execution) => {
        const formattedConsole = formatEvalConsole(execution.logs);
        const formattedResult = formatEvalValue(execution.result);
        const formattedValue = [
          ...(formattedConsole === "" ? [] : [`Console\n${formattedConsole}`]),
          `Result\n${formattedResult}`,
        ].join("\n\n");
        setStatus("Eval complete");
        setOutput(truncateOutput(formattedValue));
        setConsoleOutput(truncateOutput(formattedConsole));
        setResultOutput(truncateOutput(formattedResult));
        setCopyableOutput(formattedResult);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          setStatus("Eval stopped");
          clearOutput();
          return;
        }

        const formattedError = formatEvalError(error);
        setStatus("Eval failed");
        setOutput(truncateOutput(formattedError));
        setConsoleOutput("");
        setResultOutput(truncateOutput(formattedError));
        setCopyableOutput(formattedError);
      })
      .finally(() => {
        if (evalController === controller) {
          evalController = undefined;
          setRunning(false);
        }
      });
  };

  const stopEval = () => {
    const controller = evalController;
    if (controller === undefined || controller.signal.aborted) {
      return;
    }

    setStatus("Stopping eval");
    controller.abort();
  };

  const startPanelDrag: JSX.EventHandler<HTMLElement, PointerEvent> = (
    event,
  ) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    cleanupPanelPointer?.();
    const startFrame = panelFrame();
    const startX = event.clientX;
    const startY = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setPanelFrame(
        clampPanelFrame({
          ...startFrame,
          x: startFrame.x + moveEvent.clientX - startX,
          y: startFrame.y + moveEvent.clientY - startY,
        }),
      );
    };
    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      cleanupPanelPointer = undefined;
    };

    cleanupPanelPointer = handlePointerUp;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
  };

  const handlePanelKeyDown: JSX.EventHandler<HTMLElement, KeyboardEvent> = (
    event,
  ) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();

      runEval();
      return;
    }

    if (event.key !== "Escape" && event.key !== "Tab") {
      event.stopPropagation();
    }
  };

  return (
    <aside
      aria-label="Debug evaluator"
      class="game-debug-eval"
      style={{
        bottom: open() ? undefined : "0.75rem",
        display: "grid",
        gap: "0.5rem",
        left: open() ? `${panelFrame().x}px` : undefined,
        position: "fixed",
        right: open() ? undefined : "0.75rem",
        top: open() ? `${panelFrame().y}px` : undefined,
        "z-index": "10002",
        "pointer-events": "auto",
      }}
    >
      <Show
        when={open()}
        fallback={
          <Button class="game-debug-eval__open" onClick={() => setOpen(true)}>
            Debug Eval
          </Button>
        }
      >
        <div
          ref={(element) => {
            panelElement = element;
          }}
          class="game-debug-eval__panel"
          onKeyDown={handlePanelKeyDown}
          style={{
            height: `${panelFrame().height}px`,
            "max-height": `calc(100vh - ${panelFrame().y + DEBUG_PANEL_MARGIN_PX}px)`,
            "max-width": `calc(100vw - ${panelFrame().x + DEBUG_PANEL_MARGIN_PX}px)`,
            width: `${panelFrame().width}px`,
          }}
        >
          <div class="game-debug-eval__header" onPointerDown={startPanelDrag}>
            <strong>Debug Eval</strong>
            <div
              class="game-debug-eval__header-actions"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Tabs
                aria-label="Debug evaluator mode"
                class="game-debug-eval__mode"
                onValueChange={(details) =>
                  selectMode(details.value as DebugEvalMode)
                }
                value={mode()}
              >
                <TabsList>
                  <TabsTrigger disabled={running()} value="script">
                    Script
                  </TabsTrigger>
                  <TabsTrigger disabled={running()} value="flash">
                    Flash
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <Button
                aria-label="Close debug evaluator"
                class="game-debug-eval__close"
                onClick={() => setOpen(false)}
                size="sm"
                variant="outline"
              >
                Close
              </Button>
            </div>
          </div>
          <Textarea
            aria-label={`${mode() === "script" ? "Script" : "Flash"} debug eval code`}
            class="game-debug-eval__source"
            fullWidth
            size="sm"
            spellcheck={false}
            value={currentSource()}
            onInput={(event) => {
              const source = event.currentTarget.value;
              if (mode() === "script") {
                setScriptSource(source);
              } else {
                setFlashSource(source);
              }
            }}
          />
          <div class="game-debug-eval__footer-actions">
            <Button disabled={running()} onClick={runEval} size="sm">
              {running() ? "Running" : "Eval"}
            </Button>
            <Show when={running()}>
              <Button onClick={stopEval} size="sm" variant="outline">
                Stop
              </Button>
            </Show>
            <Button
              aria-label={
                outputCopied()
                  ? "Debug eval result copied"
                  : "Copy debug eval result"
              }
              class="game-debug-eval__copy-output"
              disabled={copyableOutput() === null}
              onClick={() => void copyOutput()}
              size="sm"
              title={outputCopied() ? "Copied" : "Copy result"}
              variant="outline"
            >
              <Icon
                icon={outputCopied() ? "check" : "copy"}
                class="button__icon"
              />
              {outputCopied() ? "Copied" : "Copy"}
            </Button>
          </div>
          <div class="game-debug-eval__output">
            <div class="game-debug-eval__status-row">
              <span>{status()}</span>
            </div>
            <Show when={output() !== ""}>
              <Show when={consoleOutput() !== ""}>
                <section class="game-debug-eval__result">
                  <strong>Console</strong>
                  <pre class="game-debug-eval__pre">{consoleOutput()}</pre>
                </section>
              </Show>
              <section class="game-debug-eval__result">
                <strong>
                  {status() === "Eval failed" ? "Error" : "Result"}
                </strong>
                <pre class="game-debug-eval__pre">{resultOutput()}</pre>
              </section>
            </Show>
          </div>
        </div>
      </Show>
    </aside>
  );
}

export function App(props: {
  readonly initialSettings?: AppSettings | null;
  readonly onGroupCommandReceiverReady?: () => void;
  readonly platform: AppPlatform;
}): JSX.Element {
  const [settings, setSettings] = createSignal<AppSettings>(
    props.initialSettings ?? DEFAULT_APP_SETTINGS,
  );
  const [loadState, setLoadState] = createSignal<GameLoadState>({
    phase: "loading",
    progress: 0,
  });
  const [gameLoaderMounted, setGameLoaderMounted] = createSignal(true);
  const loadRecoveryTimer = window.setTimeout(() => {
    setLoadState((state) =>
      state.phase === "loading"
        ? { phase: "delayed", progress: state.progress }
        : state,
    );
  }, GAME_LOAD_RECOVERY_DELAY_MS);
  onCleanup(() => window.clearTimeout(loadRecoveryTimer));
  let resolveGameLoaded: (() => void) | undefined;
  const gameLoadedPromise = new Promise<void>((resolve) => {
    resolveGameLoaded = () => resolve();
  });
  const [openMenu, setOpenMenu] = createSignal<GameTopNavMenu | null>(null);
  const [topNavVisible, setTopNavVisible] = createSignal(true);
  const [gameViewPresentation, setGameViewPresentation] =
    createSignal<GameViewPresentation>({
      active: true,
      layout: desktop.gameView.initialLayout ?? "focused",
      windowActive: true,
    });
  const effectiveTopNavVisible = createMemo(
    () => topNavVisible() && gameViewPresentation().layout === "focused",
  );
  const hotkeyStatus = createHotkeyStatus();
  const [flashSettings, setFlashSettings] = createSignal<FlashSettingsSnapshot>(
    DEFAULT_FLASH_SETTINGS,
  );
  const [walkSpeed, setWalkSpeed] = createSignal(
    String(DEFAULT_FLASH_SETTINGS.walkSpeed),
  );
  const [frameRate, setFrameRate] = createSignal(
    String(DEFAULT_FLASH_SETTINGS.frameRate),
  );
  const [renderingModePending, setRenderingModePending] = createSignal(false);
  const [customName, setCustomName] = createSignal("");
  const [customGuild, setCustomGuild] = createSignal("");
  const [scriptRoomPolicy, setScriptRoomPolicy] = createSignal<RoomPolicy>(
    DEFAULT_ACCOUNT_SETTINGS.scripts.roomPolicy,
  );
  const [scriptSafeStartStop, setScriptSafeStartStop] = createSignal(true);
  const [scriptRestartAfterReconnect, setScriptRestartAfterReconnect] =
    createSignal(false);
  const [scriptRoomNumberDraft, setScriptRoomNumberDraft] = createSignal("");
  const [scriptRoomNumberError, setScriptRoomNumberError] = createSignal("");
  const [scriptOptionsSaveStatus, setScriptOptionsSaveStatus] =
    createSignal<ScriptOptionsSaveStatus>("idle");
  let scriptOptionsSaveSequence = 0;
  let scriptOptionsSavingTimer: number | undefined;
  const [boundScriptSettingsUsername, setBoundScriptSettingsUsername] =
    createSignal<string | null>(null);
  const scriptSettingsReady = createMemo(
    () => boundScriptSettingsUsername() !== null,
  );
  const [loadedScript, setLoadedScript] = createSignal<ScriptFile | null>(null);
  const [scriptInputValues, setScriptInputValues] =
    createSignal<ScriptInputValues>({});
  const [scriptInputDialogOpen, setScriptInputDialogOpen] = createSignal(false);
  const [scriptInputDialogMode, setScriptInputDialogMode] =
    createSignal<ScriptInputsDialogMode>("manual");
  const [scriptInputDialogDefinition, setScriptInputDialogDefinition] =
    createSignal<ScriptInputsDefinition | null>(null);
  const [scriptInputDialogScriptName, setScriptInputDialogScriptName] =
    createSignal("script");
  const [scriptInputDraftValues, setScriptInputDraftValues] =
    createSignal<ScriptInputDraftValues>({});
  const [scriptInputDialogError, setScriptInputDialogError] =
    createSignal<ScriptInputsDialogError | null>(null);

  onCleanup(() => {
    if (scriptOptionsSavingTimer !== undefined) {
      window.clearTimeout(scriptOptionsSavingTimer);
    }
  });
  const [scriptInputDialogSaving, setScriptInputDialogSaving] =
    createSignal(false);
  const [scriptsDialogOpen, setScriptsDialogOpen] = createSignal(false);
  const [scriptReplacementDialogOpen, setScriptReplacementDialogOpen] =
    createSignal(false);
  const [queueReplacementDialogOpen, setQueueReplacementDialogOpen] =
    createSignal(false);
  const [scriptRunnerStatus, setScriptRunnerStatus] =
    createSignal<ScriptRunnerStatus>({ state: "idle" });
  const [scriptBusy, setScriptBusy] = createSignal(false);
  const [scriptStopInFlight, setScriptStopInFlight] = createSignal(false);
  const [scriptQueueState, setScriptQueueState] =
    createSignal<ScriptQueueState>({
      currentIndex: null,
      entries: [],
      latestRun: null,
      phase: "idle",
    });
  const [fatalScriptAlert, setFatalScriptAlert] =
    createSignal<FatalScriptAlert | null>(null);
  const [fatalScriptAlertOpen, setFatalScriptAlertOpen] = createSignal(false);
  const [scriptDialogRequest, setScriptDialogRequest] =
    createSignal<ScriptDialogRequest | null>(null);
  const [fatalScriptAlertCopied, setFatalScriptAlertCopied] =
    createSignal(false);
  const scriptInputFieldRefs = new Map<string, HTMLElement>();
  const scriptInputEditorRefs = new Map<string, HTMLElement>();
  let scriptQueue: ScriptQueue;
  let pendingAccountInputDialog: PendingAccountInputDialog | null = null;
  let pendingQueueInputDialog: PendingQueueInputDialog | null = null;
  let pendingQueueReplacementConfirmation: PendingQueueReplacementConfirmation | null =
    null;
  const [selectedAutoAttackProfileId, setSelectedAutoAttackProfileId] =
    createSignal(DEFAULT_COMBAT_PROFILE_ID);
  const [combatProfileLibrary, setCombatProfileLibrary] =
    createSignal<CombatProfileLibrary>(DEFAULT_COMBAT_PROFILE_LIBRARY);
  const [autoAttackEnabled, setAutoAttackEnabled] = createSignal(false);
  const [autoAttackProfileLabel, setAutoAttackProfileLabel] = createSignal("");
  const [autoAttackLastError, setAutoAttackLastError] = createSignal("");
  const [autoAttackWarnings, setAutoAttackWarnings] = createSignal<
    readonly string[]
  >([]);
  const [autoAttackTargetPriority, setAutoAttackTargetPriority] =
    createSignal("");
  const [autoZoneMap, setAutoZoneMap] = createSignal<
    AutoZoneSupportedMap | undefined
  >();
  const [autoZoneEnabled, setAutoZoneEnabled] = createSignal(false);
  const [autoReloginDelaySeconds, setAutoReloginDelaySeconds] = createSignal(
    AUTO_RELOGIN_DEFAULT_DELAY_SECONDS,
  );
  const [autoReloginServer, setAutoReloginServer] = createSignal("");
  const [autoReloginServers, setAutoReloginServers] = createSignal<
    readonly string[]
  >([]);
  const [autoReloginEnabled, setAutoReloginEnabled] = createSignal(false);
  const [autoReloginCaptured, setAutoReloginCaptured] = createSignal(false);
  const [autoReloginAttempting, setAutoReloginAttempting] = createSignal(false);
  const [autoReloginWaitingDelay, setAutoReloginWaitingDelay] =
    createSignal(false);
  const [autoReloginToggling, setAutoReloginToggling] = createSignal(false);
  const [autoReloginLastError, setAutoReloginLastError] = createSignal("");
  const [autoReloginAttemptsRemaining, setAutoReloginAttemptsRemaining] =
    createSignal<number | null>(null);
  const [cells, setCells] = createSignal<readonly string[]>(DEFAULT_CELLS);
  const [pads] = createSignal<readonly string[]>(DEFAULT_PADS);
  const [validPads, setValidPads] = createSignal<readonly string[]>([]);
  const [selectedCell, setSelectedCell] = createSignal(DEFAULT_CELL);
  const [selectedPad, setSelectedPad] = createSignal(DEFAULT_PAD);
  const [travelBusy, setTravelBusy] = createSignal(false);
  const gameLoaded = createMemo(() => loadState().phase === "loaded");
  const gameLoadDelayed = createMemo(() => loadState().phase === "delayed");
  const progress = createMemo(() => loadState().progress);
  const [gameLoadRecoveryError, setGameLoadRecoveryError] = createSignal("");
  const [gameLoadRecoveryPending, setGameLoadRecoveryPending] =
    createSignal(false);
  const platformLabel = createMemo(() => props.platform);
  const [playerLoggedIn, setPlayerLoggedIn] = createSignal(false);
  const [playerReady, setPlayerReady] = createSignal(false);
  const scriptReady = createMemo(() => playerReady() && scriptSettingsReady());
  let autoAttackToggleInFlight = false;
  let playerReadyRefreshVersion = 0;
  let playerReadyRetryTimer: number | undefined;
  let playerReadyRetryToken = 0;
  let accountLaunchController: AbortController | undefined;
  const [activeAccountLaunchPayload, setActiveAccountLaunchPayload] =
    createSignal<AccountGameLaunchPayload | null>(null);
  const accountSessionTracker = makeAccountSessionTracker({
    onReportError: (error) => {
      console.error("[game:account-session]", "status report failed", error);
    },
    rendererGeneration: desktop.gameRenderer.getGeneration(),
    report: desktop.gameAccounts.reportSession,
  });
  let scriptSettingsBindToken = 0;
  let lastShownFatalScriptAlertKey = "";
  let fatalScriptAlertCopiedTimer: number | undefined;
  const scriptLoaded = createMemo(() => loadedScript() !== null);
  const scriptRunning = createMemo(() => {
    const state = scriptRunnerStatus().state;
    return (
      state === "running" ||
      state === "starting" ||
      state === "stopping" ||
      state === "waiting-to-restart"
    );
  });
  const scriptQueueActive = createMemo(
    () => scriptQueueState().phase !== "idle",
  );
  const scriptControlActive = createMemo(
    () => scriptQueueActive() || scriptRunning(),
  );
  const scriptControlAvailable = createMemo(
    () => scriptLoaded() || scriptQueueActive(),
  );
  const scriptTogglePending = createMemo(() => {
    const state = scriptRunnerStatus().state;
    return (
      scriptStopInFlight() ||
      scriptQueueState().phase === "preparing" ||
      scriptQueueState().phase === "stopping" ||
      state === "stopping" ||
      (scriptBusy() && state !== "running" && state !== "starting")
    );
  });
  const scriptInputsAvailable = createMemo(
    () =>
      loadedScript()?.inputs !== null && loadedScript()?.inputs !== undefined,
  );
  const scriptStatus = createMemo(() =>
    scriptQueueState().phase === "idle"
      ? scriptStatusLabel(loadedScript(), scriptRunnerStatus())
      : scriptQueueState().phase === "preparing"
        ? "Preparing script queue"
        : scriptQueueState().phase === "stopping"
          ? "Stopping script queue"
          : scriptQueueState().phase === "paused"
            ? "Script queue paused after a failure"
            : `Queue ${(scriptQueueState().currentIndex ?? 0) + 1} of ${scriptQueueState().latestRun?.items.length ?? scriptQueueState().entries.length}: ${scriptStatusLabel(null, scriptRunnerStatus())}`,
  );
  const setLoadProgress = (percent: number): void => {
    if (!Number.isFinite(percent)) return;
    const progress = Math.max(0, Math.min(100, Math.round(percent)));
    setLoadState((state) =>
      state.phase === "loaded" || state.progress === progress
        ? state
        : { ...state, progress },
    );
  };
  const markLoaded = () => {
    window.clearTimeout(loadRecoveryTimer);
    setLoadState((state) =>
      state.phase === "loaded" ? state : { phase: "loaded", progress: 100 },
    );
    resolveGameLoaded?.();
  };
  const markGameViewActive = () => {
    if (gameViewPresentation().active) return;
    void desktop.gameView.activate().catch((cause: unknown) => {
      console.error("[game:view] activation failed", cause);
    });
  };

  window.onLoaded = markLoaded;
  window.onGameInteraction = markGameViewActive;
  window.onProgress = setLoadProgress;
  onCleanup(() => {
    if (window.onLoaded === markLoaded) delete window.onLoaded;
    if (window.onGameInteraction === markGameViewActive) {
      delete window.onGameInteraction;
    }
    if (window.onProgress === setLoadProgress) delete window.onProgress;
  });

  const applyFlashSettingsState = (state: FlashSettingsSnapshot) => {
    setFlashSettings(state);
    setWalkSpeed(String(state.walkSpeed));
    setFrameRate(String(state.frameRate));
    setCustomName(state.customName);
    setCustomGuild(state.customGuild);
  };

  const patchFlashSettingsState = (patch: Partial<FlashSettingsSnapshot>) => {
    setFlashSettings((state) => ({
      ...state,
      ...patch,
    }));
  };

  const refreshFlashSettings = () => {
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { settings } = yield* Api;
          return yield* settings.get();
        }),
      )
      .then(applyFlashSettingsState)
      .catch((error: unknown) => {
        console.error("[game:settings]", "refresh failed", error);
      });
  };

  const executeSettingsUpdate = (
    optimisticPatch: Partial<FlashSettingsSnapshot>,
    update: (settings: ApiService["settings"]) => Effect.Effect<void>,
  ): Promise<FlashSettingsSnapshot> => {
    patchFlashSettingsState(optimisticPatch);

    return runtime
      .runPromise(
        Effect.gen(function* () {
          const { settings } = yield* Api;
          yield* update(settings);
          return yield* settings.get();
        }),
      )
      .then((state) => {
        applyFlashSettingsState(state);
        return state;
      })
      .catch((error: unknown) => {
        refreshFlashSettings();
        throw error;
      });
  };

  const runSettingsUpdate = (
    label: string,
    optimisticPatch: Partial<FlashSettingsSnapshot>,
    update: (settings: ApiService["settings"]) => Effect.Effect<void>,
  ) => {
    void executeSettingsUpdate(optimisticPatch, update).catch(
      (error: unknown) => {
        console.error("[game:settings]", `${label} failed`, error);
      },
    );
  };

  const executeFlashSetting = (
    key: keyof Pick<
      FlashSettingsSnapshot,
      | "animationsEnabled"
      | "antiCounterEnabled"
      | "collisionsEnabled"
      | "deathAdsVisible"
      | "enemyMagnetEnabled"
      | "infiniteRangeEnabled"
      | "otherPlayersVisible"
      | "provokeCellEnabled"
      | "skipCutscenesEnabled"
    >,
    enabled: boolean,
    update: (
      settings: ApiService["settings"],
      enabled: boolean,
    ) => Effect.Effect<void>,
  ): Promise<FlashSettingsSnapshot> =>
    executeSettingsUpdate({ [key]: enabled }, (settings) =>
      update(settings, enabled),
    );

  const setFlashSetting = (
    label: string,
    key: keyof Pick<
      FlashSettingsSnapshot,
      | "animationsEnabled"
      | "antiCounterEnabled"
      | "collisionsEnabled"
      | "deathAdsVisible"
      | "enemyMagnetEnabled"
      | "infiniteRangeEnabled"
      | "otherPlayersVisible"
      | "provokeCellEnabled"
      | "skipCutscenesEnabled"
    >,
    enabled: boolean,
    update: (
      settings: ApiService["settings"],
      enabled: boolean,
    ) => Effect.Effect<void>,
  ): Promise<boolean | undefined> =>
    executeFlashSetting(key, enabled, update)
      .then((state) => state[key])
      .catch((error: unknown) => {
        console.error("[game:settings]", `${label} failed`, error);
        return undefined;
      });

  const handleHidePlayersCheckedChange = (
    hidden: boolean,
  ): Promise<boolean | undefined> => {
    const visible = !hidden;
    return executeSettingsUpdate({ otherPlayersVisible: visible }, (settings) =>
      settings.setOtherPlayersVisible(visible),
    )
      .then((state) => !state.otherPlayersVisible)
      .catch((error: unknown) => {
        console.error("[game:settings]", "hide players failed", error);
        return undefined;
      });
  };

  const handleSetWalkSpeed = (speed: number) => {
    runSettingsUpdate("set walk speed", { walkSpeed: speed }, (settings) =>
      settings.setWalkSpeed(speed),
    );
  };

  const optionsDisabled = () => !gameLoaded() || !playerReady();

  const handleSetFrameRate = (fps: number) => {
    runSettingsUpdate("set frame rate", { frameRate: fps }, (settings) =>
      settings.setFrameRate(fps),
    );
  };

  const runMapAction = (
    label: string,
    action: (map: ApiService["map"]) => Effect.Effect<void>,
  ): void => {
    if (optionsDisabled()) return;

    setOpenMenu(null);
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { map } = yield* Api;
          yield* action(map);
        }),
      )
      .catch((error: unknown) => {
        console.error("[game:map]", `${label} failed`, error);
      });
  };

  const handleReloadMap = (): void => {
    runMapAction("reload", (map) => map.reload());
  };

  const handleSetSpawnPoint = (): void => {
    runMapAction("set spawnpoint", (map) => map.setSpawnPoint());
  };

  const runRenderingModeUpdate = async (
    label: string,
    optimisticMode: RenderingMode,
    update: (settings: ApiService["settings"]) => Effect.Effect<void>,
  ): Promise<RenderingMode | undefined> => {
    if (
      renderingModePending() ||
      flashSettings().renderingMode === optimisticMode ||
      optionsDisabled()
    ) {
      return undefined;
    }

    patchFlashSettingsState({ renderingMode: optimisticMode });
    setRenderingModePending(true);

    try {
      const state = await runtime.runPromise(
        Effect.gen(function* () {
          const { settings } = yield* Api;
          yield* update(settings);
          return yield* settings.get();
        }),
      );
      applyFlashSettingsState(state);
      return state.renderingMode;
    } catch (error) {
      console.error("[game:settings]", `${label} failed`, error);
      refreshFlashSettings();
      return undefined;
    } finally {
      setRenderingModePending(false);
    }
  };

  const handleSetRenderingMode = (
    mode: RenderingMode,
  ): Promise<RenderingMode | undefined> =>
    runRenderingModeUpdate("set rendering mode", mode, (settings) =>
      settings.setRenderingMode(mode),
    );

  const handleRestoreRenderingMode = async (): Promise<
    RenderingMode | undefined
  > => {
    if (renderingModePending() || flashSettings().renderingMode !== "minimal") {
      return undefined;
    }

    setRenderingModePending(true);
    try {
      const state = await runtime.runPromise(
        Effect.gen(function* () {
          const { settings } = yield* Api;
          yield* settings.restoreRenderingMode();
          return yield* settings.get();
        }),
      );
      applyFlashSettingsState(state);
      return state.renderingMode;
    } catch (error) {
      console.error("[game:settings]", "restore rendering mode failed", error);
      refreshFlashSettings();
      return undefined;
    } finally {
      setRenderingModePending(false);
    }
  };

  const toggleInterfaceOnlyRenderingFromHotkey = async (): Promise<void> => {
    const mode = await handleSetRenderingMode(
      flashSettings().renderingMode === "interface-only"
        ? "full"
        : "interface-only",
    );
    if (mode !== undefined) {
      hotkeyStatus.show(formatHotkeyRenderingModeStatus(mode));
    }
  };

  const toggleMinimalRenderingFromHotkey = async (): Promise<void> => {
    const mode = await (flashSettings().renderingMode === "minimal"
      ? handleRestoreRenderingMode()
      : handleSetRenderingMode("minimal"));
    if (mode !== undefined) {
      hotkeyStatus.show(formatHotkeyRenderingModeStatus(mode));
    }
  };

  const handleSetCustomName = () => {
    const name = customName();
    runSettingsUpdate("set custom name", { customName: name }, (settings) =>
      settings.setCustomName(name),
    );
  };

  const handleSetCustomGuild = () => {
    const guild = customGuild();
    runSettingsUpdate("set custom guild", { customGuild: guild }, (settings) =>
      settings.setCustomGuild(guild),
    );
  };

  const handleResetCustomName = () => {
    runSettingsUpdate(
      "reset custom name",
      { customName: "", customNameConfigured: false },
      (settings) => settings.resetCustomName,
    );
  };

  const handleResetCustomGuild = () => {
    runSettingsUpdate(
      "reset custom guild",
      { customGuild: "", customGuildConfigured: false },
      (settings) => settings.resetCustomGuild,
    );
  };

  const optionItems = createMemo<readonly GameTopNavOptionItem[]>(() => [
    {
      id: "infinite-range",
      hotkeyStatusLabel: "Infinite range",
      label: "Infinite Range",
      type: "toggle",
      checked: flashSettings().infiniteRangeEnabled,
      disabled: optionsDisabled(),
      onCheckedChange: (enabled) =>
        setFlashSetting(
          "toggle infinite range",
          "infiniteRangeEnabled",
          enabled,
          (settings, enabled) => settings.setInfiniteRangeEnabled(enabled),
        ),
    },
    {
      id: "provoke-cell",
      hotkeyStatusLabel: "Provoke cell",
      label: "Provoke Cell",
      type: "toggle",
      checked: flashSettings().provokeCellEnabled,
      disabled: optionsDisabled(),
      onCheckedChange: (enabled) =>
        setFlashSetting(
          "toggle provoke cell",
          "provokeCellEnabled",
          enabled,
          (settings, enabled) => settings.setProvokeCellEnabled(enabled),
        ),
    },
    {
      id: "enemy-magnet",
      hotkeyStatusLabel: "Enemy magnet",
      label: "Enemy Magnet",
      type: "toggle",
      checked: flashSettings().enemyMagnetEnabled,
      disabled: optionsDisabled(),
      onCheckedChange: (enabled) =>
        setFlashSetting(
          "toggle enemy magnet",
          "enemyMagnetEnabled",
          enabled,
          (settings, enabled) => settings.setEnemyMagnetEnabled(enabled),
        ),
    },
    {
      id: "rendering-mode",
      label: "Rendering Mode",
      mode: flashSettings().renderingMode,
      pending: renderingModePending(),
      type: "rendering-mode",
      disabled: optionsDisabled(),
      onModeChange: handleSetRenderingMode,
    },
    {
      id: "hide-players",
      hotkeyStatusLabel: "Hide players",
      label: "Hide Players",
      type: "toggle",
      checked: !flashSettings().otherPlayersVisible,
      disabled: optionsDisabled(),
      onCheckedChange: handleHidePlayersCheckedChange,
    },
    {
      id: "skip-cutscenes",
      hotkeyStatusLabel: "Skip cutscenes",
      label: "Skip Cutscenes",
      type: "toggle",
      checked: flashSettings().skipCutscenesEnabled,
      disabled: optionsDisabled(),
      onCheckedChange: (enabled) =>
        setFlashSetting(
          "toggle skip cutscenes",
          "skipCutscenesEnabled",
          enabled,
          (settings, enabled) => settings.setSkipCutscenesEnabled(enabled),
        ),
    },
    {
      id: "anti-counter",
      hotkeyStatusLabel: "Anti-counter",
      label: "Anti-Counter",
      type: "toggle",
      checked: flashSettings().antiCounterEnabled,
      disabled: optionsDisabled(),
      onCheckedChange: (enabled) =>
        setFlashSetting(
          "toggle anti-counter",
          "antiCounterEnabled",
          enabled,
          (settings, enabled) => settings.setAntiCounterEnabled(enabled),
        ),
    },
    {
      id: "animations",
      hotkeyStatusLabel: "Animations",
      label: "Animations",
      type: "toggle",
      checked: flashSettings().animationsEnabled,
      disabled: optionsDisabled(),
      onCheckedChange: (enabled) =>
        setFlashSetting(
          "toggle animations",
          "animationsEnabled",
          enabled,
          (settings, enabled) => settings.setAnimationsEnabled(enabled),
        ),
    },
    {
      id: "collisions",
      hotkeyStatusLabel: "Collisions",
      label: "Collisions",
      type: "toggle",
      checked: flashSettings().collisionsEnabled,
      disabled: optionsDisabled(),
      onCheckedChange: (enabled) =>
        setFlashSetting(
          "toggle collisions",
          "collisionsEnabled",
          enabled,
          (settings, enabled) => settings.setCollisionsEnabled(enabled),
        ),
    },
    {
      id: "death-ads",
      hotkeyStatusLabel: "Death ads",
      label: "Death Ads",
      type: "toggle",
      checked: flashSettings().deathAdsVisible,
      disabled: optionsDisabled(),
      onCheckedChange: (enabled) =>
        setFlashSetting(
          "toggle death ads",
          "deathAdsVisible",
          enabled,
          (settings, enabled) => settings.setDeathAdsVisible(enabled),
        ),
    },
  ]);

  const handleSelectAutoAttackProfile = (profileId: string) => {
    if (autoAttackEnabled()) {
      return;
    }

    setSelectedAutoAttackProfileId(
      getAvailableAutoAttackProfileId(combatProfileLibrary(), profileId),
    );
  };

  const applyAutoZoneState = (state: AutoZoneState) => {
    setAutoZoneEnabled(state.enabled);
    setAutoZoneMap(state.map);
  };

  const refreshAutoZoneState = () => {
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoZone } = yield* Automation;
          return yield* autoZone.getState();
        }),
      )
      .then(applyAutoZoneState)
      .catch((error: unknown) => {
        console.error("[game:autozone]", "refresh failed", error);
      });
  };

  const handleToggleAutoZone = () => {
    const nextEnabled = !autoZoneEnabled();
    setAutoZoneEnabled(nextEnabled);

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoZone } = yield* Automation;
          yield* autoZone.setEnabled(nextEnabled);
          return yield* autoZone.getState();
        }),
      )
      .then(applyAutoZoneState)
      .catch((error: unknown) => {
        console.error("[game:autozone]", "toggle failed", error);
        refreshAutoZoneState();
      });
  };

  const handleSelectAutoZoneMap = (map: AutoZoneSupportedMap | undefined) => {
    setAutoZoneMap(map);

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoZone } = yield* Automation;
          yield* autoZone.setMap(map);
          return yield* autoZone.getState();
        }),
      )
      .then(applyAutoZoneState)
      .catch((error: unknown) => {
        console.error("[game:autozone]", "set map failed", error);
        refreshAutoZoneState();
      });
  };

  const applyAutoReloginState = (state: AutoReloginState) => {
    setAutoReloginEnabled(state.enabled);
    setAutoReloginCaptured(state.captured);
    setAutoReloginAttempting(state.attempting);
    setAutoReloginWaitingDelay(state.waitingDelay);
    setAutoReloginDelaySeconds(formatDelaySeconds(state.delayMs));
    setAutoReloginServer(state.server ?? "");
    setAutoReloginLastError(state.lastError ?? "");
    setAutoReloginAttemptsRemaining(state.attemptsRemaining ?? null);
  };

  const refreshAutoReloginState = () => {
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoRelogin } = yield* Automation;
          return yield* autoRelogin.getState();
        }),
      )
      .then(applyAutoReloginState)
      .catch((error: unknown) => {
        console.error("[game:autorelogin]", "refresh failed", error);
      });
  };

  const refreshAutoReloginServers = () => {
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { auth } = yield* Api;
          return yield* auth.getServers();
        }),
      )
      .then((servers) => {
        setAutoReloginServers(servers.map((server) => server.name));
      })
      .catch((error: unknown) => {
        console.error("[game:autorelogin]", "server refresh failed", error);
      });
  };

  const handleToggleAutoRelogin = () => {
    if (autoReloginToggling()) {
      return;
    }

    const nextEnabled = !autoReloginEnabled();
    setAutoReloginToggling(true);

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoRelogin } = yield* Automation;
          yield* autoRelogin.setEnabled(nextEnabled);
          return yield* autoRelogin.getState();
        }),
      )
      .then(applyAutoReloginState)
      .catch((error: unknown) => {
        console.error("[game:autorelogin]", "toggle failed", error);
        refreshAutoReloginState();
      })
      .finally(() => {
        setAutoReloginToggling(false);
      });
  };

  const handleSelectAutoReloginServer = (server: string) => {
    setAutoReloginServer(server);

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoRelogin } = yield* Automation;
          yield* autoRelogin.setServer(server);
          return yield* autoRelogin.getState();
        }),
      )
      .then(applyAutoReloginState)
      .catch((error: unknown) => {
        console.error("[game:autorelogin]", "set server failed", error);
        refreshAutoReloginState();
      });
  };

  const handleSetAutoReloginDelay = () => {
    const delayMs = parseDelayMs(autoReloginDelaySeconds());
    if (delayMs === null) {
      refreshAutoReloginState();
      return;
    }

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoRelogin } = yield* Automation;
          yield* autoRelogin.setDelay(delayMs);
          return yield* autoRelogin.getState();
        }),
      )
      .then(applyAutoReloginState)
      .catch((error: unknown) => {
        console.error("[game:autorelogin]", "set delay failed", error);
        refreshAutoReloginState();
      });
  };

  const refreshPlayerReady = async (): Promise<boolean> => {
    const version = ++playerReadyRefreshVersion;
    const identityEpoch = accountSessionTracker.currentIdentityEpoch();
    try {
      const username = await readReadyPlayerUsername();
      // Once a session is ready, transient cell/map transition reads must not
      // disable the controls. Explicit unload and disconnect events reset it.
      if (version !== playerReadyRefreshVersion || username === undefined) {
        return false;
      }

      if (!accountSessionTracker.markOnline(identityEpoch, username)) {
        return false;
      }
      setPlayerLoggedIn(true);
      const settingsBound = await bindScriptSettingsForAccount(username);
      if (
        version !== playerReadyRefreshVersion ||
        identityEpoch !== accountSessionTracker.currentIdentityEpoch() ||
        !settingsBound
      ) {
        return false;
      }

      setPlayerReady(true);
      return true;
    } catch (error) {
      console.error("[game:player]", "readiness refresh failed", error);
      return false;
    }
  };

  const clearPlayerReadyRetry = () => {
    if (playerReadyRetryTimer === undefined) {
      return;
    }

    window.clearTimeout(playerReadyRetryTimer);
    playerReadyRetryTimer = undefined;
  };

  const stopPlayerReadyRetry = () => {
    playerReadyRetryToken += 1;
    playerReadyRefreshVersion += 1;
    clearPlayerReadyRetry();
  };

  const schedulePlayerReadyRefresh = ({
    onReady,
    retry = false,
  }: {
    readonly onReady?: () => void;
    readonly retry?: boolean;
  } = {}) => {
    const token = ++playerReadyRetryToken;
    const startedAt = Date.now();

    playerReadyRefreshVersion += 1;
    clearPlayerReadyRetry();

    const run = () => {
      playerReadyRetryTimer = undefined;

      if (token !== playerReadyRetryToken || !gameLoaded()) {
        return;
      }

      void refreshPlayerReady().then((ready) => {
        if (token !== playerReadyRetryToken || !gameLoaded()) {
          return;
        }

        if (ready) {
          onReady?.();
          return;
        }

        if (!retry || Date.now() - startedAt >= PLAYER_READY_RETRY_TIMEOUT_MS) {
          return;
        }

        playerReadyRetryTimer = window.setTimeout(
          run,
          PLAYER_READY_RETRY_INTERVAL_MS,
        );
      });
    };

    run();
  };

  const ensurePlayerReady = (): Promise<boolean> =>
    playerReady() ? Promise.resolve(true) : refreshPlayerReady();

  const waitForPlayerReadyUntilCancelled = async (
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<boolean> => {
    const startedAt = Date.now();
    while (!signal.aborted) {
      if (await refreshPlayerReady()) return true;
      if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) {
        return false;
      }
      await wait(PLAYER_READY_RETRY_INTERVAL_MS);
    }
    return false;
  };

  const applyTravelOptions = ({
    currentCell,
    currentPad,
    mapCells,
    mapPads,
  }: TravelOptions) => {
    setCells(mapCells.length > 0 ? mapCells : DEFAULT_CELLS);
    setValidPads(mapPads);
    setSelectedCell(currentCell || mapCells[0] || DEFAULT_CELL);
    setSelectedPad(currentPad || DEFAULT_PAD);
  };

  const syncTravelOptionsFromState = () => {
    void ensurePlayerReady()
      .then((ready) => (ready ? readTravelOptions() : null))
      .then((options) => {
        if (options !== null) {
          applyTravelOptions(options);
        }
      })
      .catch((error: unknown) => {
        console.error("[game:travel]", "state sync failed", error);
      });
  };

  const refreshTravelOptions = () => {
    if (!playerReady()) {
      return;
    }

    void readTravelOptions()
      .then((options) => {
        if (options === null) {
          return null;
        }

        applyTravelOptions(options);
        return readTravelOptions();
      })
      .then((options) => {
        if (options !== null) {
          applyTravelOptions(options);
        }
      })
      .catch((error: unknown) => {
        console.error("[game:travel]", "refresh failed", error);
      });
  };

  const refreshTravelOptionsAfterJump = () => {
    if (!playerReady()) {
      return;
    }

    void readTravelOptions()
      .then((options) => {
        if (options !== null) {
          applyTravelOptions(options);
        }
      })
      .catch((error: unknown) => {
        console.error("[game:travel]", "post-jump refresh failed", error);
      });
  };

  const resetTravelOptions = () => {
    setCells(DEFAULT_CELLS);
    setValidPads([]);
    setSelectedCell(DEFAULT_CELL);
    setSelectedPad(DEFAULT_PAD);
    setTravelBusy(false);
  };

  const jumpToCellPad = (cell: string, pad: string) => {
    if (!playerReady() || travelBusy()) {
      return;
    }

    const targetCell = cell.trim() || DEFAULT_CELL;
    const targetPad = pad.trim();

    setTravelBusy(true);
    setSelectedCell(targetCell);
    if (targetPad !== "") {
      setSelectedPad(targetPad);
    }
    setOpenMenu(null);

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { player } = yield* Api;
          yield* player.jumpToCell(
            targetCell,
            targetPad === "" ? undefined : targetPad,
          );
          const [currentCell, currentPad] = yield* Effect.all([
            player.getCell(),
            player.getPad(),
          ]);

          return {
            currentCell,
            currentPad,
          };
        }),
      )
      .then(({ currentCell, currentPad }) => {
        setSelectedCell(currentCell.trim() || targetCell);
        setSelectedPad(currentPad.trim() || targetPad || DEFAULT_PAD);
        refreshTravelOptionsAfterJump();
      })
      .catch((error: unknown) => {
        console.error("[game:travel]", "jump failed", error);
        schedulePlayerReadyRefresh({ retry: true });
      })
      .finally(() => {
        setTravelBusy(false);
      });
  };

  const handleSelectCell = (cell: string) => {
    jumpToCellPad(cell, selectedPad());
  };

  const handleSelectPad = (pad: string) => {
    jumpToCellPad(selectedCell(), pad);
  };

  const autoAttackConfiguredProfileLabel = createMemo(() =>
    getAutoAttackConfiguredProfileLabel(
      combatProfileLibrary(),
      selectedAutoAttackProfileId(),
    ),
  );

  const applyAutoAttackState = (state: AutoAttackState): void => {
    setAutoAttackEnabled(state.enabled);
    setAutoAttackProfileLabel(
      state.profileLabel ?? autoAttackConfiguredProfileLabel(),
    );
    setAutoAttackLastError(state.lastError ?? "");
    setAutoAttackWarnings(state.warnings);
  };

  const refreshAutoAttackState = (): void => {
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoAttack } = yield* Automation;
          return yield* autoAttack.getState();
        }),
      )
      .then(applyAutoAttackState)
      .catch((error: unknown) => {
        console.error("[game:autoattack]", "state refresh failed", error);
      });
  };

  const applyCombatProfileLibrary = (library: CombatProfileLibrary): void => {
    setCombatProfileLibrary(library);
    const selectedProfileId = getAvailableAutoAttackProfileId(
      library,
      selectedAutoAttackProfileId(),
    );
    if (selectedProfileId !== selectedAutoAttackProfileId()) {
      setSelectedAutoAttackProfileId(selectedProfileId);
    }
    if (!autoAttackEnabled()) {
      setAutoAttackProfileLabel(
        getAutoAttackConfiguredProfileLabel(library, selectedProfileId),
      );
    }
  };

  const handleToggleAutoAttack = async (): Promise<boolean | undefined> => {
    if (autoAttackToggleInFlight || (!autoAttackEnabled() && !playerReady())) {
      return undefined;
    }

    autoAttackToggleInFlight = true;
    const nextEnabled = !autoAttackEnabled();
    setAutoAttackEnabled(nextEnabled);

    try {
      const state = await runtime.runPromise(
        Effect.gen(function* () {
          const { autoAttack } = yield* Automation;
          const library = combatProfileLibrary();
          const selectedProfileId = getAvailableAutoAttackProfileId(
            library,
            selectedAutoAttackProfileId(),
          );
          if (selectedProfileId !== selectedAutoAttackProfileId()) {
            setSelectedAutoAttackProfileId(selectedProfileId);
          }
          return nextEnabled
            ? yield* autoAttack.enable({
                library,
                profileId: selectedProfileId,
                targetPriority: parseAutoAttackTargetPriority(
                  autoAttackTargetPriority(),
                ),
              })
            : yield* autoAttack.disable();
        }),
      );
      applyAutoAttackState(state);
      return state.enabled;
    } catch (error) {
      console.error("[game:autoattack]", "toggle failed", error);
      refreshAutoAttackState();
      return undefined;
    } finally {
      autoAttackToggleInFlight = false;
    }
  };

  const handleOpenBank = () => {
    if (!playerReady()) {
      return;
    }

    setOpenMenu(null);

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { bank } = yield* Api;
          yield* bank.open();
        }),
      )
      .catch((error: unknown) => {
        console.error("[game:bank]", "open failed", error);
        schedulePlayerReadyRefresh({ retry: true });
      });
  };

  const toggleTopNav = () => {
    setTopNavVisible((visible) => !visible);
    setOpenMenu(null);
  };

  const toggleOptionsMenu = () => {
    setOpenMenu((menu) => (menu === "options" ? null : "options"));
  };

  const handleOpenWindow = (id: WindowId) => {
    setOpenMenu(null);
    void desktop.windows.open(id).catch((error: unknown) => {
      console.error(`[game] failed to open window ${id}`, error);
    });
  };

  const getScriptInputsDefinition = (): ScriptInputsDefinition | null =>
    scriptInputDialogDefinition();

  const resetScriptInputDialogRefs = (): void => {
    scriptInputFieldRefs.clear();
    scriptInputEditorRefs.clear();
  };

  const setScriptInputFieldRef = (key: string, element: HTMLElement): void => {
    scriptInputFieldRefs.set(key, element);
  };

  const setScriptInputEditorRef = (key: string, element: HTMLElement): void => {
    scriptInputEditorRefs.set(key, element);
  };

  const scriptInputFieldHasError = (key: string): boolean =>
    scriptInputDialogError()?.fields.some((field) => field.key === key) ??
    false;

  const scriptInputFieldErrorMessage = (key: string): string | undefined =>
    scriptInputDialogError()?.fields.find((field) => field.key === key)
      ?.message;

  const scriptInputFieldElement = (key: string): HTMLElement | undefined =>
    scriptInputFieldRefs.get(key) ??
    Array.from(
      document.querySelectorAll<HTMLElement>(
        ".game-script-inputs-dialog__field[data-script-input-key]",
      ),
    ).find((element) => element.dataset["scriptInputKey"] === key);

  const scriptInputEditorElement = (
    fieldElement: HTMLElement | undefined,
    key: string,
  ): HTMLElement | undefined =>
    fieldElement?.querySelector<HTMLElement>(
      "[data-slot='combobox-input'], [data-slot='input'], .checkbox__input, input, button, [tabindex]:not([tabindex='-1'])",
    ) ??
    scriptInputEditorRefs.get(key) ??
    undefined;

  const focusScriptInputField = (key: string): void => {
    const fieldElement = scriptInputFieldElement(key);
    fieldElement?.scrollIntoView({ block: "center", inline: "nearest" });
    window.requestAnimationFrame(() => {
      const editorElement = scriptInputEditorElement(
        scriptInputFieldElement(key),
        key,
      );
      try {
        editorElement?.focus({ preventScroll: true });
      } catch {
        editorElement?.focus();
      }
    });
  };

  const refreshScriptInputValues = (
    definition: ScriptInputsDefinition,
  ): Promise<ScriptInputValues> => desktop.scripting.getInputValues(definition);

  const saveScriptInputValues = (
    definition: ScriptInputsDefinition,
    values: ScriptInputValues,
  ): Promise<ScriptInputValues> => {
    const normalized = normalizeScriptInputValues(definition, values);
    return desktop.scripting.saveInputValues(definition, normalized);
  };

  const showFatalScriptAlert = (alert: FatalScriptAlert): void => {
    if (alert.key === lastShownFatalScriptAlertKey) {
      return;
    }

    lastShownFatalScriptAlertKey = alert.key;
    setOpenMenu(null);
    setFatalScriptAlert(alert);
    setFatalScriptAlertCopied(false);
    setFatalScriptAlertOpen(true);
  };

  const showFatalScriptError = (
    sourceName: string,
    error: unknown,
    sourcePath?: string,
  ): void => {
    showFatalScriptAlert(
      fatalScriptAlertFromError(sourceName, error, sourcePath),
    );
  };

  const applyScriptRunnerStatus = (status: ScriptRunnerStatus): void => {
    setScriptRunnerStatus(status);
    const queuePhase = scriptQueueState().phase;
    const queueOwnsRunner =
      queuePhase === "running" || queuePhase === "stopping";
    if (status.state === "failed" && !queueOwnsRunner) {
      showFatalScriptAlert(fatalScriptAlertFromStatus(status));
    }
  };

  const markFatalScriptAlertCopied = (): void => {
    if (fatalScriptAlertCopiedTimer !== undefined) {
      window.clearTimeout(fatalScriptAlertCopiedTimer);
    }

    setFatalScriptAlertCopied(true);
    fatalScriptAlertCopiedTimer = window.setTimeout(() => {
      setFatalScriptAlertCopied(false);
      fatalScriptAlertCopiedTimer = undefined;
    }, 900);
  };

  const copyFatalScriptAlertDetails = async (): Promise<void> => {
    const detailsText = fatalScriptAlert()?.detailsText;
    if (detailsText === undefined || detailsText.trim() === "") {
      return;
    }

    try {
      await navigator.clipboard.writeText(detailsText);
      markFatalScriptAlertCopied();
    } catch (error) {
      console.error("Failed to copy script stack trace:", error);
    }
  };

  const stopScriptRun = async (reason: string): Promise<ScriptRunnerStatus> => {
    const status = await runtime.runPromise(
      Effect.gen(function* () {
        const runner = yield* ScriptRunner;
        return yield* runner.stop(reason);
      }),
    );
    applyScriptRunnerStatus(status);
    return status;
  };

  const stopScriptForReplacement = async (): Promise<void> => {
    await stopScriptRun("replaced");
  };

  const applyLoadedScript = async (
    file: ScriptFile,
    options: {
      readonly replaceRunning: boolean;
      readonly start: boolean;
    },
    timing?: ScriptTimingTrace,
  ): Promise<void> => {
    const inputDefinition = file.inputs;
    const inputValues =
      inputDefinition === null
        ? {}
        : timing === undefined
          ? await refreshScriptInputValues(inputDefinition)
          : await timeScriptStage(timing, "load-input-values.ipc", () =>
              refreshScriptInputValues(inputDefinition),
            );

    if (scriptControlActive()) {
      if (!options.replaceRunning) {
        throw new Error("A script is already running.");
      }
      if (scriptQueueActive()) {
        await scriptQueue.cancel("Replaced by a manual script load");
      }
      if (scriptRunning()) {
        if (timing === undefined) {
          await stopScriptForReplacement();
        } else {
          await timeScriptStage(timing, "stop-replaced-script", () =>
            stopScriptForReplacement(),
          );
        }
      }
    }

    setLoadedScript(file);
    setScriptRunnerStatus({ state: "idle" });
    setScriptInputDialogError(null);
    setScriptInputValues(inputValues);
    setOpenMenu(null);

    if (options.start) {
      await prepareAndStartLoadedScript(file, inputValues, undefined, timing);
    }
  };

  const chooseScriptFile = async (replaceRunning = false): Promise<void> => {
    if (scriptBusy()) {
      return;
    }

    setScriptBusy(true);
    try {
      const result = await desktop.scripting.openFile();
      if (result.canceled) {
        return;
      }
      await applyLoadedScript(result.file, {
        replaceRunning,
        start: false,
      });
    } catch (error) {
      console.error("[game:script]", "load failed", error);
      throw error;
    } finally {
      setScriptBusy(false);
    }
  };

  const selectCatalogScript = async (
    reference: ScriptReference,
    start: boolean,
    replaceRunning: boolean,
  ): Promise<void> => {
    if (scriptBusy()) return;
    const timing = beginScriptTiming(start ? "catalog-start" : "catalog-load", {
      kind: reference.kind,
      path: reference.path,
      ...(reference.kind === "package"
        ? { packageName: reference.packageName }
        : {}),
      replaceRunning,
    });
    setScriptBusy(true);
    try {
      const file = await timeScriptStage(timing, "load-reference.ipc", () =>
        desktop.scripting.loadReference(reference),
      );
      await timeScriptStage(timing, "apply-loaded-script", () =>
        applyLoadedScript(file, { replaceRunning, start }, timing),
      );
      completeScriptTiming(timing, "completed");
    } catch (error) {
      completeScriptTiming(timing, "failed", error);
      console.error("[game:script]", "catalog selection failed", error);
      throw error;
    } finally {
      setScriptBusy(false);
    }
  };

  const openScripts = (): void => {
    setOpenMenu(null);
    setScriptsDialogOpen(true);
  };

  const loadScript = (): void => {
    if (scriptBusy()) {
      return;
    }

    setOpenMenu(null);
    if (scriptControlActive()) {
      setScriptReplacementDialogOpen(true);
      return;
    }

    void chooseScriptFile(false);
  };

  const toggleScriptsDialog = (): void => {
    setOpenMenu(null);
    setScriptsDialogOpen((open) => !open);
  };

  const openScriptInputsDialog = (
    mode: ScriptInputsDialogMode,
    definition: ScriptInputsDefinition,
    values: ScriptInputValues,
    scriptName = loadedScript()?.name ?? "script",
  ): void => {
    resetScriptInputDialogRefs();
    setScriptInputDialogMode(mode);
    setScriptInputDialogDefinition(definition);
    setScriptInputDialogScriptName(scriptName);
    setScriptInputDraftValues(scriptInputDraftFromValues(definition, values));
    setScriptInputDialogError(null);
    setScriptInputDialogSaving(false);
    setScriptInputDialogOpen(true);
    setOpenMenu(null);
  };

  const settleAccountInputDialog = (values: ScriptInputValues | null): void => {
    const pending = pendingAccountInputDialog;
    if (pending === null) return;
    pendingAccountInputDialog = null;
    pending.abort();
    resetScriptInputDialogRefs();
    setScriptInputDialogOpen(false);
    setScriptInputDialogError(null);
    setScriptInputDialogDefinition(null);
    pending.resolve(values);
  };

  const requestAccountInputs = (
    definition: ScriptInputsDefinition,
    values: ScriptInputValues,
    scriptName: string,
    signal: AbortSignal,
  ): Promise<ScriptInputValues | null> => {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onAbort = () => settleAccountInputDialog(null);
      signal.addEventListener("abort", onAbort, { once: true });
      pendingAccountInputDialog = {
        abort: () => signal.removeEventListener("abort", onAbort),
        resolve,
      };
      openScriptInputsDialog(
        "account-required",
        definition,
        values,
        scriptName,
      );
    });
  };

  const settleQueueInputDialog = (values: ScriptInputValues | null): void => {
    const pending = pendingQueueInputDialog;
    if (pending === null) return;
    pendingQueueInputDialog = null;
    pending.abort();
    resetScriptInputDialogRefs();
    setScriptInputDialogOpen(false);
    setScriptInputDialogError(null);
    setScriptInputDialogDefinition(null);
    pending.resolve(values);
    if (pending.reopenScriptsDialog) {
      queueMicrotask(() => setScriptsDialogOpen(true));
    }
  };

  const requestQueueInputs = (
    request: ScriptQueueInputRequest,
  ): Promise<ScriptInputValues | null> => {
    if (request.signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const reopenScriptsDialog = scriptsDialogOpen();
      const onAbort = () => settleQueueInputDialog(null);
      request.signal.addEventListener("abort", onAbort, { once: true });
      pendingQueueInputDialog = {
        abort: () => request.signal.removeEventListener("abort", onAbort),
        reopenScriptsDialog,
        resolve,
      };
      if (reopenScriptsDialog) setScriptsDialogOpen(false);
      openScriptInputsDialog(
        request.reason === "add"
          ? "queue-add"
          : request.reason === "edit"
            ? "queue-edit"
            : "queue-preflight",
        request.definition,
        request.values,
        request.file.name,
      );
    });
  };

  const settleQueueReplacementConfirmation = (confirmed: boolean): void => {
    const pending = pendingQueueReplacementConfirmation;
    if (pending === null) return;
    pendingQueueReplacementConfirmation = null;
    pending.abort();
    setQueueReplacementDialogOpen(false);
    pending.resolve(confirmed);
  };

  const confirmQueueStandaloneReplacement = (
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => settleQueueReplacementConfirmation(false);
      signal.addEventListener("abort", onAbort, { once: true });
      pendingQueueReplacementConfirmation = {
        abort: () => signal.removeEventListener("abort", onAbort),
        resolve,
      };
      setQueueReplacementDialogOpen(true);
    });
  };

  const openScriptInputs = () => {
    const definition = loadedScript()?.inputs ?? null;
    if (
      definition === null ||
      scriptControlActive() ||
      scriptInputDialogSaving()
    ) {
      return;
    }

    openScriptInputsDialog("manual", definition, scriptInputValues());
  };

  const cancelScriptInputsDialog = (): void => {
    if (scriptInputDialogSaving()) {
      return;
    }

    if (scriptInputDialogMode().startsWith("queue-")) {
      settleQueueInputDialog(null);
      return;
    }

    if (scriptInputDialogMode() === "account-required") {
      settleAccountInputDialog(null);
      return;
    }

    if (scriptInputDialogMode() === "required") {
      const file = loadedScript();
      if (file !== null) {
        accountSessionTracker.setScript({
          message: "Script inputs canceled",
          name: file.name,
          state: "stopped",
        });
      }
    }

    resetScriptInputDialogRefs();
    setScriptInputDialogOpen(false);
    setScriptInputDialogError(null);
    setScriptInputDialogDefinition(null);
  };

  const startScriptRun = async (
    file: ScriptFile,
    inputValues: ScriptInputValues,
    timing?: ScriptTimingTrace,
  ) => {
    const start = () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const runner = yield* ScriptRunner;
          return yield* runner.start(file, inputValues);
        }),
      );
    const handle: ScriptRunHandle =
      timing === undefined
        ? await start()
        : await timeScriptStage(timing, "runner-start", start);
    applyScriptRunnerStatus(handle.initialStatus);
    return {
      terminal: runtime.runPromise(handle.terminal),
    };
  };

  const startLoadedScript = async (
    file: ScriptFile,
    inputValues: ScriptInputValues,
    timing?: ScriptTimingTrace,
  ): Promise<void> => {
    if (scriptQueueActive()) {
      await scriptQueue.cancel("Replaced by a manual script start");
    }
    await startScriptRun(file, inputValues, timing);
    setOpenMenu(null);
  };

  const resolveScriptQueueFile = async (
    reference: ScriptFileReference,
  ): Promise<ScriptFile> => {
    const result =
      reference.reference === undefined
        ? await desktop.scripting.resolveFile(reference.path)
        : await desktop.scripting.resolveReference(reference.reference);
    switch (result.status) {
      case "found":
        return result.file;
      case "missing":
        throw new Error(
          `${reference.name} could not be found. Restore the file or remove it from the queue.`,
        );
      case "failed":
        throw new Error(result.message);
    }
  };

  scriptQueue = makeScriptQueue({
    confirmStandaloneReplacement: confirmQueueStandaloneReplacement,
    createId: createRandomId,
    isRunnerActive: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const runner = yield* ScriptRunner;
          return yield* runner.isRunning();
        }),
      ),
    onUnexpectedError: (cause) => {
      console.error("[game:script-queue]", "unexpected queue failure", cause);
    },
    requestInputs: requestQueueInputs,
    resolve: resolveScriptQueueFile,
    startScript: (file, inputValues) => startScriptRun(file, inputValues),
    stopScript: async (reason) => {
      await stopScriptRun(reason);
    },
  });
  const disposeScriptQueueState = scriptQueue.onState(setScriptQueueState);
  onCleanup(() => {
    disposeScriptQueueState();
    scriptQueue.dispose();
  });

  const enqueueCatalogScript = async (
    reference: ScriptReference,
  ): Promise<boolean> => {
    if (scriptQueueState().phase !== "idle") return false;
    const file = await desktop.scripting.loadReference(reference);
    const inputValues =
      file.inputs === null ? {} : await refreshScriptInputValues(file.inputs);
    return (await scriptQueue.add(file, inputValues)) !== null;
  };

  const prepareAndStartLoadedScript = async (
    currentFile: ScriptFile,
    currentInputValues: ScriptInputValues,
    inputsPersistedForRevision?: string,
    timing?: ScriptTimingTrace,
  ): Promise<void> => {
    const prepare = () =>
      prepareScriptStart(
        { file: currentFile, inputValues: currentInputValues },
        {
          getInputValues: (definition) =>
            timing === undefined
              ? refreshScriptInputValues(definition)
              : timeScriptStage(timing, "refresh-input-values.ipc", () =>
                  refreshScriptInputValues(definition),
                ),
          readFile: (path) => {
            const read = () =>
              currentFile.reference === undefined
                ? desktop.scripting.readFile(path)
                : desktop.scripting.readReference(currentFile.reference);
            return timing === undefined
              ? read()
              : timeScriptStage(
                  timing,
                  currentFile.reference === undefined
                    ? "read-file.ipc"
                    : "read-reference.ipc",
                  read,
                );
          },
        },
      );
    const prepared =
      timing === undefined
        ? await prepare()
        : await timeScriptStage(timing, "start-preparation", prepare);
    const revisionChanged = prepared.file.revision !== currentFile.revision;

    setLoadedScript(prepared.file);
    setScriptInputValues(prepared.inputValues);
    setScriptInputDialogError(null);
    if (revisionChanged) {
      setScriptRunnerStatus({ state: "idle" });
    }

    if (
      prepared.status === "missing-required" &&
      prepared.file.inputs !== null
    ) {
      if (timing !== undefined) {
        reportScriptTiming(timing, "stage", {
          outcome: "deferred",
          stage: "required-inputs",
        });
      }
      accountSessionTracker.setScript({
        message: "Waiting for script inputs",
        name: prepared.file.name,
        state: "starting",
      });
      openScriptInputsDialog(
        "required",
        prepared.file.inputs,
        prepared.inputValues,
      );
      return;
    }

    let inputValues = prepared.inputValues;
    const preparedInputDefinition = prepared.file.inputs;
    if (
      preparedInputDefinition !== null &&
      prepared.file.revision !== inputsPersistedForRevision
    ) {
      const save = () =>
        saveScriptInputValues(preparedInputDefinition, inputValues);
      inputValues =
        timing === undefined
          ? await save()
          : await timeScriptStage(timing, "save-input-values.ipc", save);
      setScriptInputValues(inputValues);
    }

    await startLoadedScript(prepared.file, inputValues, timing);
  };

  const applyScriptOptions = (options: ScriptRuntimeOptions): void => {
    setScriptRestartAfterReconnect(options.restartAfterReconnect);
    setScriptRoomPolicy({ ...options.roomPolicy });
    setScriptSafeStartStop(options.safeStartStop);
    setScriptRoomNumberDraft(
      formatRoomNumberInput(
        options.roomPolicy.kind === "specific"
          ? options.roomPolicy.roomNumber
          : null,
      ),
    );
    setScriptRoomNumberError("");
  };

  const clearScriptOptionsSaveFeedback = (): void => {
    scriptOptionsSaveSequence += 1;
    if (scriptOptionsSavingTimer !== undefined) {
      window.clearTimeout(scriptOptionsSavingTimer);
      scriptOptionsSavingTimer = undefined;
    }
    setScriptOptionsSaveStatus("idle");
  };

  const clearScriptSettingsBinding = (): void => {
    scriptSettingsBindToken += 1;
    setBoundScriptSettingsUsername(null);
    clearScriptOptionsSaveFeedback();
  };

  const bindScriptSettingsForAccount = async (
    username: string,
  ): Promise<boolean> => {
    const normalized = username.toLowerCase();
    if (boundScriptSettingsUsername() === normalized) {
      return true;
    }

    const token = ++scriptSettingsBindToken;
    setBoundScriptSettingsUsername(null);
    clearScriptOptionsSaveFeedback();
    try {
      const options = await runtime.runPromise(
        Effect.gen(function* () {
          const runner = yield* ScriptRunner;
          return yield* runner.bindAccount(username);
        }),
      );
      if (token !== scriptSettingsBindToken) return false;

      applyScriptOptions(options);
      setBoundScriptSettingsUsername(normalized);
      return true;
    } catch (error) {
      if (token === scriptSettingsBindToken) {
        setBoundScriptSettingsUsername(null);
      }
      console.error("[game:script]", "account settings binding failed", error);
      return false;
    }
  };

  const waitForGameLoaded = async (): Promise<boolean> => {
    if (gameLoaded()) return true;
    return Promise.race([
      gameLoadedPromise.then(() => true),
      wait(ACCOUNT_LAUNCH_GAME_LOAD_TIMEOUT_MS).then(() => false),
    ]);
  };

  const runAccountLaunch = async (
    payload: AccountGameLaunchPayload,
    options: { readonly startScript?: boolean } = {},
  ): Promise<void> => {
    accountLaunchController?.abort();
    const controller = new AbortController();
    accountLaunchController = controller;
    setActiveAccountLaunchPayload(payload);
    stopPlayerReadyRetry();
    const launchAttempt = accountSessionTracker.beginLaunch(
      payload.account.username,
    );
    accountSessionTracker.setLaunchScript(
      launchAttempt,
      accountSessionScriptState(
        scriptRunnerStatus(),
        accountScriptLabel(payload.script),
      ),
    );
    accountSessionTracker.start();
    let loginComplete = false;
    let authenticatedIdentityEpoch: number | undefined;

    const requireLaunchIdentity = (): void => {
      if (
        authenticatedIdentityEpoch === undefined ||
        !accountSessionTracker.isOnlineAs(
          authenticatedIdentityEpoch,
          payload.account.username,
        )
      ) {
        throw new Error("Account connection changed during script setup");
      }
    };

    try {
      const loaded = await waitForGameLoaded();
      if (!accountSessionTracker.isCurrentLaunch(launchAttempt)) return;
      if (!loaded) {
        throw new Error(`Game did not finish loading (${progress()}%)`);
      }

      const loginResult = await runtime.runPromise(
        Effect.gen(function* () {
          const { autoRelogin } = yield* Automation;
          return yield* autoRelogin.runLogin({
            onLifecycle: (event) =>
              Effect.sync(() =>
                accountSessionTracker.setLogin(
                  launchAttempt,
                  accountLaunchLoginState(event, payload.server),
                ),
              ),
            password: payload.account.password,
            ...(payload.server === undefined ? {} : { server: payload.server }),
            username: payload.account.username,
          });
        }),
        { signal: controller.signal },
      );
      if (!accountSessionTracker.isCurrentLaunch(launchAttempt)) return;

      let ready: boolean;
      if (loginResult.status === "server-select") {
        accountSessionTracker.setLogin(launchAttempt, {
          state: "waiting-for-server",
        });
        if (payload.script === undefined || options.startScript === false) {
          return;
        }

        ready = await waitForPlayerReadyUntilCancelled(controller.signal);
      } else {
        ready = await waitForPlayerReadyUntilCancelled(
          controller.signal,
          PLAYER_READY_RETRY_TIMEOUT_MS,
        );
      }
      if (!accountSessionTracker.isCurrentLaunch(launchAttempt)) return;
      if (!ready && controller.signal.aborted) return;

      const connection = accountSessionTracker.getRuntime().connection;
      if (connection.state !== "online") {
        throw new Error("Player did not become ready");
      }
      if (
        connection.username.localeCompare(payload.account.username, undefined, {
          sensitivity: "accent",
        }) !== 0
      ) {
        throw new Error(
          `Expected ${payload.account.username}, connected as ${connection.username}`,
        );
      }
      loginComplete = true;
      authenticatedIdentityEpoch = accountSessionTracker.currentIdentityEpoch();
      if (!ready) {
        throw new Error("Player settings could not be loaded");
      }
      if (payload.script === undefined || options.startScript === false) {
        return;
      }

      const scriptName =
        accountScriptLabel(payload.script) ?? payload.script.path;
      accountSessionTracker.setLaunchScript(launchAttempt, {
        message: "Loading script",
        name: scriptName,
        state: "starting",
      });
      const file = await resolveAccountScript(
        (path) =>
          payload.script?.reference === undefined
            ? desktop.scripting.resolveFile(path)
            : desktop.scripting.resolveReference(payload.script.reference),
        payload.script.path,
      );
      if (!accountSessionTracker.isCurrentLaunch(launchAttempt)) return;
      requireLaunchIdentity();
      if (file === null) {
        setLoadedScript(null);
        setScriptRunnerStatus({ state: "idle" });
        setScriptInputValues({});
        setScriptInputDialogError(null);
        accountSessionTracker.setLaunchScript(launchAttempt, {
          message: "Script not found",
          name: scriptName,
          state: "stopped",
        });
        return;
      }
      setLoadedScript(file);
      setScriptRunnerStatus({ state: "idle" });
      setScriptInputDialogError(null);

      let inputValues: ScriptInputValues = {};
      const inputDefinition = file.inputs;
      if (inputDefinition !== null) {
        const refreshed = await refreshScriptInputValues(inputDefinition);
        if (!accountSessionTracker.isCurrentLaunch(launchAttempt)) return;
        requireLaunchIdentity();
        const storedInputs = validateScriptInputValues(
          inputDefinition,
          refreshed,
        );
        if (storedInputs.status === "missing-required") {
          setScriptInputValues(storedInputs.values);
          accountSessionTracker.setLaunchScript(launchAttempt, {
            message: "Waiting for script inputs",
            name: scriptName,
            state: "starting",
          });
          const enteredInputs = await requestAccountInputs(
            inputDefinition,
            storedInputs.values,
            scriptName,
            controller.signal,
          );
          if (
            controller.signal.aborted ||
            !accountSessionTracker.isCurrentLaunch(launchAttempt)
          ) {
            return;
          }
          requireLaunchIdentity();
          if (enteredInputs === null) {
            accountSessionTracker.setLaunchScript(launchAttempt, {
              message: "Script inputs canceled",
              name: scriptName,
              state: "stopped",
            });
            return;
          }

          const validatedInputs = validateScriptInputValues(
            inputDefinition,
            enteredInputs,
          );
          if (validatedInputs.status === "missing-required") {
            throw new Error("Required script inputs are still missing.");
          }
          inputValues = validatedInputs.values;
        } else {
          inputValues = storedInputs.values;
        }
        inputValues = await saveScriptInputValues(inputDefinition, inputValues);
        if (!accountSessionTracker.isCurrentLaunch(launchAttempt)) return;
        requireLaunchIdentity();
      }
      setScriptInputValues(inputValues);

      accountSessionTracker.setLaunchScript(launchAttempt, {
        message: "Starting script",
        name: scriptName,
        state: "starting",
      });
      requireLaunchIdentity();
      await startLoadedScript(file, inputValues);
    } catch (error) {
      if (!accountSessionTracker.isCurrentLaunch(launchAttempt)) return;
      const message =
        error instanceof Error ? error.message : "Account launch failed";
      console.error("[game:account-launch]", message, error);
      if (payload.script !== undefined) {
        showFatalScriptError(
          accountScriptLabel(payload.script) ?? "script",
          error,
          payload.script.path,
        );
      }
      if (loginComplete) {
        if (payload.script !== undefined) {
          const scriptName = accountScriptLabel(payload.script);
          accountSessionTracker.setLaunchScript(launchAttempt, {
            message,
            ...(scriptName === undefined ? {} : { name: scriptName }),
            state: "failed",
          });
        }
      } else {
        accountSessionTracker.failLaunch(launchAttempt, message);
      }
    } finally {
      if (accountLaunchController === controller) {
        accountLaunchController = undefined;
      }
    }
  };

  const runGroupLogin = async (): Promise<void> => {
    const payload = activeAccountLaunchPayload();
    if (payload === null) return;
    await runAccountLaunch(payload, { startScript: false });
  };

  const reloadGameAfterLoadStall = async (): Promise<void> => {
    if (gameLoadRecoveryPending()) return;

    setGameLoadRecoveryError("");
    setGameLoadRecoveryPending(true);
    try {
      await desktop.gameAccounts.prepareGameLoadRecovery();
      window.location.reload();
    } catch (error) {
      console.error(
        "[game:load-recovery]",
        "failed to prepare game reload",
        error,
      );
      setGameLoadRecoveryError("Unable to reload the game. Try again.");
      setGameLoadRecoveryPending(false);
    }
  };

  const runGroupLogout = async (): Promise<void> => {
    accountLaunchController?.abort();
    accountSessionTracker.cancelLaunch();
    try {
      await stopRunningScript("group logout");
      await runtime.runPromise(
        Effect.gen(function* () {
          const { auth } = yield* Api;
          yield* auth.logout();
        }),
      );
      accountSessionTracker.disconnected();
      stopPlayerReadyRetry();
      setPlayerLoggedIn(false);
      setPlayerReady(false);
      clearScriptSettingsBinding();
      resetTravelOptions();
    } catch (error) {
      console.error("[game:group]", "logout failed", error);
      schedulePlayerReadyRefresh({ retry: true });
    }
  };

  const loadGroupScript = async (file: ScriptFile): Promise<void> => {
    if (scriptBusy()) return;

    setScriptBusy(true);
    try {
      await applyLoadedScript(file, {
        replaceRunning: true,
        start: false,
      });
    } catch (error) {
      console.error("[game:group]", "load script failed", error);
    } finally {
      setScriptBusy(false);
    }
  };

  const runGroupLocation = async (
    map: string,
    cell: string,
    pad: string,
  ): Promise<void> => {
    if (!(await ensurePlayerReady())) return;

    const targetMap = map.trim();
    const targetCell = cell.trim();
    const targetPad = pad.trim();
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const { player } = yield* Api;
          if (targetMap !== "") {
            yield* player.joinMap(targetMap, {
              ...(targetCell === "" ? {} : { cell: targetCell }),
              ...(targetPad === "" ? {} : { pad: targetPad }),
            });
            return;
          }
          yield* player.jumpToCell(
            targetCell === "" ? DEFAULT_CELL : targetCell,
            targetPad === "" ? undefined : targetPad,
          );
        }),
      );
      refreshTravelOptionsAfterJump();
    } catch (error) {
      console.error("[game:group]", "travel failed", error);
    }
  };

  const runGroupGoToPlayer = async (playerName: string): Promise<void> => {
    if (!(await ensurePlayerReady())) return;
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const { player } = yield* Api;
          yield* player.goToPlayer(playerName.trim());
        }),
      );
      refreshTravelOptionsAfterJump();
    } catch (error) {
      console.error("[game:group]", "go to player failed", error);
    }
  };

  const runGroupRenderingMode = async (mode: RenderingMode): Promise<void> => {
    await executeSettingsUpdate({ renderingMode: mode }, (settings) =>
      settings.setRenderingMode(mode),
    );
  };

  const runGroupOption = async (
    option: Extract<GameViewGroupCommand, { readonly kind: "set-option" }>,
  ): Promise<void> => {
    switch (option.option) {
      case "hide-players": {
        const visible = !option.enabled;
        await executeSettingsUpdate(
          { otherPlayersVisible: visible },
          (settings) => settings.setOtherPlayersVisible(visible),
        );
        return;
      }
      case "animations":
        await executeFlashSetting(
          "animationsEnabled",
          option.enabled,
          (settings, enabled) => settings.setAnimationsEnabled(enabled),
        );
        return;
      case "anti-counter":
        await executeFlashSetting(
          "antiCounterEnabled",
          option.enabled,
          (settings, enabled) => settings.setAntiCounterEnabled(enabled),
        );
        return;
      case "collisions":
        await executeFlashSetting(
          "collisionsEnabled",
          option.enabled,
          (settings, enabled) => settings.setCollisionsEnabled(enabled),
        );
        return;
      case "death-ads":
        await executeFlashSetting(
          "deathAdsVisible",
          option.enabled,
          (settings, enabled) => settings.setDeathAdsVisible(enabled),
        );
        return;
      case "enemy-magnet":
        await executeFlashSetting(
          "enemyMagnetEnabled",
          option.enabled,
          (settings, enabled) => settings.setEnemyMagnetEnabled(enabled),
        );
        return;
      case "infinite-range":
        await executeFlashSetting(
          "infiniteRangeEnabled",
          option.enabled,
          (settings, enabled) => settings.setInfiniteRangeEnabled(enabled),
        );
        return;
      case "provoke-cell":
        await executeFlashSetting(
          "provokeCellEnabled",
          option.enabled,
          (settings, enabled) => settings.setProvokeCellEnabled(enabled),
        );
        return;
      case "skip-cutscenes":
        await executeFlashSetting(
          "skipCutscenesEnabled",
          option.enabled,
          (settings, enabled) => settings.setSkipCutscenesEnabled(enabled),
        );
    }
  };

  const runGroupCommand = async (
    command: GameViewGroupCommand,
  ): Promise<void> => {
    switch (command.kind) {
      case "start-scripts":
        await startCurrentScript("group-start");
        return;
      case "stop-scripts":
        await stopRunningScript("group stop");
        return;
      case "load-script":
        await loadGroupScript(command.file);
        return;
      case "login":
        await runGroupLogin();
        return;
      case "logout":
        await runGroupLogout();
        return;
      case "join-location":
        await runGroupLocation(command.map, command.cell, command.pad);
        return;
      case "go-to-player":
        await runGroupGoToPlayer(command.player);
        return;
      case "run-option-hotkey": {
        const handler = commandHandlers().get(command.commandId);
        if (handler !== undefined) await handler();
        return;
      }
      case "set-rendering-mode":
        await runGroupRenderingMode(command.mode);
        return;
      case "set-option":
        await runGroupOption(command);
    }
  };

  const persistScriptInputs = async () => {
    const definition = getScriptInputsDefinition();
    if (definition === null) {
      setScriptInputDialogOpen(false);
      return;
    }

    if (scriptInputDialogSaving()) {
      return;
    }

    const result = scriptInputValuesFromDraft(
      definition,
      scriptInputDraftValues(),
    );
    if (!result.ok) {
      setScriptInputDialogError(result.error);
      window.requestAnimationFrame(() => {
        const first = result.error.fields[0];
        if (first !== undefined) {
          focusScriptInputField(first.key);
        }
      });
      return;
    }

    if (scriptInputDialogMode().startsWith("queue-")) {
      setScriptInputDialogSaving(true);
      settleQueueInputDialog(result.values);
      setScriptInputDialogSaving(false);
      return;
    }

    if (scriptInputDialogMode() === "account-required") {
      setScriptInputDialogSaving(true);
      settleAccountInputDialog(result.values);
      setScriptInputDialogSaving(false);
      return;
    }

    const file = loadedScript();
    if (file === null) {
      setScriptInputDialogOpen(false);
      setScriptInputDialogDefinition(null);
      return;
    }

    setScriptInputDialogSaving(true);
    const shouldStart = scriptInputDialogMode() === "required";
    if (shouldStart) {
      setScriptBusy(true);
      accountSessionTracker.setScript({
        message: "Starting script",
        name: file.name,
        state: "starting",
      });
    }

    try {
      const saved = await saveScriptInputValues(definition, result.values);
      setScriptInputValues(saved);
      setScriptInputDialogError(null);
      setScriptInputDialogOpen(false);
      resetScriptInputDialogRefs();

      if (shouldStart) {
        const timing = beginScriptTiming("required-input-start", {
          name: file.name,
          path: file.path,
          revision: file.revision,
        });
        try {
          await prepareAndStartLoadedScript(file, saved, file.revision, timing);
          completeScriptTiming(timing, "completed");
        } catch (error) {
          completeScriptTiming(timing, "failed", error);
          throw error;
        }
      }
    } catch (error) {
      console.error("[game:script]", "save inputs failed", error);
      if (shouldStart) {
        const file = loadedScript();
        if (file !== null) {
          showFatalScriptError(file.name, error, file.path);
          accountSessionTracker.setScript({
            message: formatEvalError(error),
            name: file.name,
            state: "failed",
          });
        }
      }
      setScriptInputDialogError({
        fields: [],
        message: shouldStart
          ? "Failed to save inputs or start script."
          : "Failed to save inputs.",
      });
    } finally {
      setScriptInputDialogSaving(false);
      if (shouldStart) {
        setScriptBusy(false);
      }
    }
  };

  const updateScriptInputDraft = (
    key: string,
    value: ScriptInputDraftValue,
  ): void => {
    setScriptInputDraftValues((current) => ({ ...current, [key]: value }));
    setScriptInputDialogError(null);
  };

  const stopRunningScript = async (reason: string): Promise<void> => {
    if (!scriptControlActive() || scriptStopInFlight()) return;

    setScriptStopInFlight(true);
    try {
      if (scriptQueueActive()) {
        await scriptQueue.cancel(reason);
      }
      if (scriptRunning()) {
        await stopScriptRun(reason);
      }
    } catch (error) {
      console.error("[game:script]", "stop failed", error);
    } finally {
      setScriptStopInFlight(false);
    }
  };

  const startCurrentScript = async (
    operation: "group-start" | "loaded-start",
  ): Promise<void> => {
    if (scriptControlActive() || scriptBusy() || !scriptReady()) return;

    const file = loadedScript();
    const timing =
      file === null
        ? undefined
        : beginScriptTiming(operation, {
            name: file.name,
            path: file.path,
            revision: file.revision,
          });
    setScriptBusy(true);
    try {
      if (file === null) {
        return;
      }

      await prepareAndStartLoadedScript(
        file,
        scriptInputValues(),
        undefined,
        timing,
      );
      if (timing !== undefined) completeScriptTiming(timing, "completed");
    } catch (error) {
      if (timing !== undefined) completeScriptTiming(timing, "failed", error);
      console.error("[game:script]", "start failed", error);
      if (file !== null) {
        showFatalScriptError(file.name, error, file.path);
      }
    } finally {
      setScriptBusy(false);
    }
  };

  const toggleScript = async (): Promise<void> => {
    if (scriptControlActive()) {
      await stopRunningScript("user requested stop");
      return;
    }
    await startCurrentScript("loaded-start");
  };

  const syncScriptOptions = () => {
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const runner = yield* ScriptRunner;
          return yield* runner.getOptions();
        }),
      )
      .then(applyScriptOptions)
      .catch((error: unknown) => {
        console.error("[game:script]", "option sync failed", error);
      });
  };

  const beginScriptOptionsSave = (): number => {
    const sequence = ++scriptOptionsSaveSequence;
    if (scriptOptionsSavingTimer !== undefined) {
      window.clearTimeout(scriptOptionsSavingTimer);
    }
    setScriptOptionsSaveStatus("idle");
    scriptOptionsSavingTimer = window.setTimeout(() => {
      scriptOptionsSavingTimer = undefined;
      if (sequence === scriptOptionsSaveSequence) {
        setScriptOptionsSaveStatus("saving");
      }
    }, SCRIPT_OPTIONS_SAVING_DELAY_MS);
    return sequence;
  };

  const finishScriptOptionsSave = (
    sequence: number,
    persisted: boolean,
  ): void => {
    if (sequence !== scriptOptionsSaveSequence) return;
    if (scriptOptionsSavingTimer !== undefined) {
      window.clearTimeout(scriptOptionsSavingTimer);
      scriptOptionsSavingTimer = undefined;
    }
    setScriptOptionsSaveStatus(persisted ? "idle" : "failed");
  };

  const runScriptOptionsSave = (
    operation: () => Promise<ScriptOptionsUpdateResult>,
    failureMessage: string,
  ): void => {
    const sequence = beginScriptOptionsSave();
    void operation()
      .then((result) => {
        if (sequence !== scriptOptionsSaveSequence) return;
        applyScriptOptions(result.options);
        finishScriptOptionsSave(sequence, result.persisted);
      })
      .catch((error: unknown) => {
        console.error("[game:script]", failureMessage, error);
        if (sequence !== scriptOptionsSaveSequence) return;
        finishScriptOptionsSave(sequence, false);
        syncScriptOptions();
      });
  };

  const handleSelectScriptRoomPolicy = (
    policy: Exclude<RoomPolicy, { readonly kind: "specific" }>,
  ) => {
    setScriptRoomPolicy(policy);
    setScriptRoomNumberDraft("");
    setScriptRoomNumberError("");
    runScriptOptionsSave(
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const runner = yield* ScriptRunner;
            return yield* runner.setRoomPolicy(policy);
          }),
        ),
      "room mode update failed",
    );
  };

  const handleToggleScriptSafeStartStop = () => {
    const enabled = !scriptSafeStartStop();
    setScriptSafeStartStop(enabled);
    runScriptOptionsSave(
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const runner = yield* ScriptRunner;
            return yield* runner.setSafeStartStop(enabled);
          }),
        ),
      "safe-start-stop toggle failed",
    );
  };

  const handleToggleScriptRestartAfterReconnect = () => {
    const enabled = !scriptRestartAfterReconnect();
    setScriptRestartAfterReconnect(enabled);
    runScriptOptionsSave(
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const runner = yield* ScriptRunner;
            return yield* runner.setRestartAfterReconnect(enabled);
          }),
        ),
      "restart-after-reconnect toggle failed",
    );
  };

  const handleCommitScriptRoomNumber = () => {
    const parsed = parseRoomNumberInput(scriptRoomNumberDraft());
    if (parsed.status === "invalid") {
      setScriptRoomNumberError("Enter a room number from 1 to 99,999.");
      return;
    }

    setScriptRoomNumberError("");
    const policy: RoomPolicy = {
      kind: "specific",
      roomNumber: parsed.value,
    };
    setScriptRoomPolicy(policy);
    runScriptOptionsSave(
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const runner = yield* ScriptRunner;
            return yield* runner.setRoomPolicy(policy);
          }),
        ),
      "specific-room number update failed",
    );
  };

  const handleRetryScriptOptionsSave = (): void => {
    runScriptOptionsSave(
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const runner = yield* ScriptRunner;
            return yield* runner.persistOptions();
          }),
        ),
      "option save retry failed",
    );
  };

  const handleToggleFollower = async (): Promise<boolean | undefined> => {
    setOpenMenu(null);
    try {
      const change = await runtime.runPromise(
        Effect.gen(function* () {
          const { follower } = yield* Automation;
          const previous = yield* follower.getState();
          const current = yield* follower.toggle(combatProfileLibrary());
          return {
            current: current.enabled || current.running,
            previous: previous.enabled || previous.running,
          };
        }),
      );
      return change.current === change.previous ? undefined : change.current;
    } catch (error) {
      console.error("[game:follower]", "toggle failed", error);
      return undefined;
    }
  };

  const toggleScriptFromHotkey = async (): Promise<void> => {
    const wasRunning = scriptControlActive();
    await toggleScript();
    const running = scriptControlActive();
    if (running === wasRunning) return;

    hotkeyStatus.show(
      `Script: ${running ? "Running" : "Stopped"}`,
      !effectiveTopNavVisible(),
    );
  };

  const toggleAutoAttackFromHotkey = async (): Promise<void> => {
    const wasEnabled = autoAttackEnabled();
    const enabled = await handleToggleAutoAttack();
    if (enabled === undefined || enabled === wasEnabled) return;

    hotkeyStatus.show(
      `Auto attack: ${enabled ? "On" : "Off"}`,
      !effectiveTopNavVisible(),
    );
  };

  const toggleFollowerFromHotkey = async (): Promise<void> => {
    const enabled = await handleToggleFollower();
    if (enabled === undefined) return;
    hotkeyStatus.show(`Follower: ${enabled ? "On" : "Off"}`);
  };

  const selectOptionCommand = async (
    commandId: SettingsCommandId,
  ): Promise<void> => {
    const optionId = topNavOptionCommandIds[commandId];
    if (optionId === undefined) {
      return;
    }

    const option = optionItems().find((item) => item.id === optionId);
    if (
      option === undefined ||
      option.disabled === true ||
      option.type !== "toggle"
    ) {
      return;
    }

    const checkedPromise = option.onCheckedChange(!option.checked);
    setOpenMenu(null);
    const checked = await checkedPromise;
    if (checked === undefined) return;
    hotkeyStatus.show(
      formatHotkeyToggleStatus(option.hotkeyStatusLabel, checked),
    );
  };

  const commandHandlers = createMemo<
    ReadonlyMap<SettingsCommandId, GameHotkeyHandler>
  >(() => {
    const handlers = new Map<SettingsCommandId, GameHotkeyHandler>([
      ["toggleTopBar", toggleTopNav],
      ["loadScript", loadScript],
      ["toggleScript", toggleScriptFromHotkey],
      ["toggleScriptsDialog", toggleScriptsDialog],
      ["toggleOptionsMenu", toggleOptionsMenu],
      ["toggleAutoattack", toggleAutoAttackFromHotkey],
      ["toggleFollower", toggleFollowerFromHotkey],
      ["toggleBank", handleOpenBank],
      ["toggleInterfaceOnlyRendering", toggleInterfaceOnlyRenderingFromHotkey],
      ["toggleMinimalRendering", toggleMinimalRenderingFromHotkey],
    ]);

    for (const commandId of Object.keys(
      topNavOptionCommandIds,
    ) as SettingsCommandId[]) {
      handlers.set(commandId, () => selectOptionCommand(commandId));
    }

    for (const commandId of windowIdsByCommandId.keys()) {
      handlers.set(commandId, () => {
        const windowId = windowIdsByCommandId.get(commandId);
        if (windowId !== undefined) {
          handleOpenWindow(windowId);
        }
      });
    }

    return handlers;
  });

  const hotkeyCommandsByMatchKey = createMemo(() => {
    const handlers = commandHandlers();
    const byMatchKey = new Map<string, GameHotkeyCommand>();

    for (const command of SETTINGS_COMMANDS) {
      const handler = handlers.get(command.id);
      if (handler === undefined) {
        continue;
      }

      const matchKey = hotkeyBindingMatchKey(
        readHotkeyBinding(settings().hotkeys.bindings, command.id),
        props.platform,
      );
      if (matchKey !== null && !byMatchKey.has(matchKey)) {
        byMatchKey.set(matchKey, { commandId: command.id, handler });
      }
    }

    return byMatchKey;
  });

  onMount(() => {
    let disposed = false;
    const unsubscribeSettings = desktop.settings.onChanged(setSettings);
    const unsubscribeCombatProfiles = desktop.combatProfiles.onChanged(
      applyCombatProfileLibrary,
    );

    void desktop.settings
      .get()
      .then((nextSettings) => {
        if (!disposed) {
          setSettings(nextSettings);
        }
      })
      .catch((error: unknown) => {
        console.error("[game:settings]", "desktop sync failed", error);
      });

    void desktop.combatProfiles
      .getState()
      .then((library) => {
        if (!disposed) {
          applyCombatProfileLibrary(library);
        }
      })
      .catch((error: unknown) => {
        console.error("[game:combat-profiles]", "desktop sync failed", error);
      });

    onCleanup(() => {
      disposed = true;
      unsubscribeSettings();
      unsubscribeCombatProfiles();
    });
  });

  onMount(() => {
    const bridge = desktop.gameView;

    let disposed = false;
    const groupCommands = makeGameViewGroupCommandQueue({
      execute: runGroupCommand,
      onError: (command, cause) => {
        console.error("[game:group]", `${command.kind} command failed`, cause);
      },
    });
    const applyPresentation = (presentation: GameViewPresentation): void => {
      if (disposed) return;
      setGameViewPresentation(presentation);
      if (presentation.layout === "grid") {
        setOpenMenu(null);
      }
      void runtime
        .runPromise(
          Effect.gen(function* () {
            const { settings } = yield* Api;
            yield* settings.setFrameRateLimit(
              gameViewFrameRateLimit(presentation),
            );
          }),
        )
        .catch((cause: unknown) => {
          console.error("[game:view] frame rate sync failed", cause);
        });
    };
    const unsubscribe = bridge.onPresentationChanged(applyPresentation);
    const unsubscribeGroupCommands = bridge.onGroupCommand((envelope) => {
      if (!disposed) groupCommands.enqueue(envelope);
    });
    props.onGroupCommandReceiverReady?.();
    void bridge
      .getPresentation()
      .then(applyPresentation)
      .catch((cause: unknown) => {
        console.error("[game:view] presentation sync failed", cause);
      });

    onCleanup(() => {
      disposed = true;
      unsubscribe();
      unsubscribeGroupCommands();
      groupCommands.dispose();
    });
  });

  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        fatalScriptAlertOpen() ||
        scriptDialogRequest() !== null ||
        isEditableHotkeyTarget(event.target) ||
        isFlashTextFieldFocused()
      ) {
        return;
      }

      const matchKey = hotkeyInputMatchKey(event, props.platform);
      if (matchKey === null) {
        return;
      }

      const command = hotkeyCommandsByMatchKey().get(matchKey);
      if (command === undefined) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (
        shouldDispatchGameViewGroupOptionHotkey(
          gameViewPresentation().layout,
          command.commandId,
        )
      ) {
        void desktop.gameView
          .dispatchGroupOptionHotkey(command.commandId)
          .catch((cause: unknown) => {
            console.error("[game:group] hotkey dispatch failed", cause);
          });
        return;
      }
      void command.handler();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    });
  });

  onMount(() => {
    let autoAttackDisposer: (() => void) | undefined;
    let autoReloginDisposer: (() => void) | undefined;
    let autoZoneDisposer: (() => void) | undefined;
    let flashSettingsDisposer: (() => void) | undefined;
    let scriptOptionsDisposer: (() => void) | undefined;
    let scriptDialogDisposer: (() => void) | undefined;
    let scriptStatusDisposer: (() => void) | undefined;
    let cleanedUp = false;
    const travelEventFiber = runtime.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const { events } = yield* Api;
          yield* events.on({ type: "join-map" }, () =>
            Effect.sync(() => {
              resetTravelOptions();
              schedulePlayerReadyRefresh({
                onReady: syncTravelOptionsFromState,
                retry: true,
              });
            }),
          );
          yield* events.on({ type: "connection" }, (event) =>
            Effect.sync(() => {
              const status = event.type === "connection" ? event.status : "";
              if (
                status === "OnConnectionLost" ||
                status === "OnConnectionFailed"
              ) {
                accountSessionTracker.disconnected();
                stopPlayerReadyRetry();
                setPlayerLoggedIn(false);
                setPlayerReady(false);
                clearScriptSettingsBinding();
                resetTravelOptions();
              }

              if (status === "OnConnection") {
                accountSessionTracker.connectionStarted();
                schedulePlayerReadyRefresh({ retry: true });
              }
              refreshAutoReloginState();
            }),
          );
          return yield* Effect.never;
        }),
      ),
    );

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { settings } = yield* Api;
          return yield* settings.onState(applyFlashSettingsState);
        }),
      )
      .then((dispose) => {
        if (cleanedUp) {
          dispose();
          return;
        }

        flashSettingsDisposer = dispose;
      })
      .catch((error: unknown) => {
        console.error("[game:settings]", "state subscription failed", error);
        refreshFlashSettings();
      });

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoAttack } = yield* Automation;
          return yield* autoAttack.onState(applyAutoAttackState);
        }),
      )
      .then((dispose) => {
        if (cleanedUp) {
          dispose();
          return;
        }

        autoAttackDisposer = dispose;
      })
      .catch((error: unknown) => {
        console.error("[game:autoattack]", "state subscription failed", error);
        refreshAutoAttackState();
      });

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoZone } = yield* Automation;
          return yield* autoZone.onState(applyAutoZoneState);
        }),
      )
      .then((dispose) => {
        if (cleanedUp) {
          dispose();
          return;
        }

        autoZoneDisposer = dispose;
      })
      .catch((error: unknown) => {
        console.error("[game:autozone]", "state subscription failed", error);
      });

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const { autoRelogin } = yield* Automation;
          return yield* autoRelogin.onState(applyAutoReloginState);
        }),
      )
      .then((dispose) => {
        if (cleanedUp) {
          dispose();
          return;
        }

        autoReloginDisposer = dispose;
      })
      .catch((error: unknown) => {
        console.error("[game:autorelogin]", "state subscription failed", error);
      });

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const runner = yield* ScriptRunner;
          const status = yield* runner.getStatus();
          const options = yield* runner.getOptions();
          const dispose = yield* runner.onStatus((nextStatus) => {
            applyScriptRunnerStatus(nextStatus);
            accountSessionTracker.setScript(
              accountSessionScriptState(nextStatus),
            );
          });
          const disposeOptions = yield* runner.onOptions((nextOptions) => {
            applyScriptOptions(nextOptions);
          });
          return { dispose, disposeOptions, options, status };
        }),
      )
      .then(({ dispose, disposeOptions, options, status }) => {
        applyScriptRunnerStatus(status);
        accountSessionTracker.setScript(accountSessionScriptState(status));
        applyScriptOptions(options);

        if (cleanedUp) {
          dispose();
          disposeOptions();
          return;
        }

        scriptStatusDisposer = dispose;
        scriptOptionsDisposer = disposeOptions;
      })
      .catch((error: unknown) => {
        console.error("[game:script]", "state subscription failed", error);
      });

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const dialogs = yield* ScriptDialogs;
          return yield* dialogs.onCurrent(setScriptDialogRequest);
        }),
      )
      .then((dispose) => {
        if (cleanedUp) {
          dispose();
          return;
        }

        scriptDialogDisposer = dispose;
      })
      .catch((error: unknown) => {
        console.error("[game:script-dialog]", "subscription failed", error);
      });

    void desktop.gameAccounts
      .getGameLaunch()
      .then((payload) => {
        if (payload !== null) {
          void runAccountLaunch(payload);
          return;
        }
        accountSessionTracker.start();
      })
      .catch((error: unknown) => {
        console.error("[game:account-launch]", "payload load failed", error);
        accountSessionTracker.start();
      });

    onCleanup(() => {
      cleanedUp = true;
      autoAttackDisposer?.();
      autoReloginDisposer?.();
      autoZoneDisposer?.();
      flashSettingsDisposer?.();
      scriptDialogDisposer?.();
      scriptOptionsDisposer?.();
      scriptStatusDisposer?.();
      accountLaunchController?.abort();
      stopPlayerReadyRetry();
      resetTravelOptions();
      runtime.runFork(Fiber.interrupt(travelEventFiber));
      if (fatalScriptAlertCopiedTimer !== undefined) {
        window.clearTimeout(fatalScriptAlertCopiedTimer);
      }
    });
  });

  createEffect(() => {
    const loaded = gameLoaded();
    writeDocumentLoaded(loaded);
    if (loaded) {
      schedulePlayerReadyRefresh({ retry: true });
    } else {
      stopPlayerReadyRetry();
      setPlayerLoggedIn(false);
      setPlayerReady(false);
      clearScriptSettingsBinding();
    }
  });

  createEffect(() => {
    writeTopNavHidden(!effectiveTopNavVisible());
  });

  createEffect(() => {
    writeRenderingMinimal(flashSettings().renderingMode === "minimal");
  });

  onCleanup(() => {
    writeTopNavHidden(false);
    writeRenderingMinimal(false);
  });

  const renderScriptInputField = (field: ScriptInputField): JSX.Element => {
    const [optionQuery, setOptionQuery] = createSignal("");
    const value = () => scriptInputDraftValues()[field.key];
    const label = () => scriptInputFieldLabel(field);
    const hasError = () => scriptInputFieldHasError(field.key);
    const selectedValues = (): readonly string[] => {
      const draftValue = value();
      return field.type === "multi-select" && Array.isArray(draftValue)
        ? draftValue
        : [];
    };
    const visibleOptions = (): readonly string[] => {
      const query = optionQuery().trim().toLocaleLowerCase();
      if (query.length === 0) {
        return scriptSelectFieldOptions(field);
      }

      return scriptSelectFieldOptions(field).filter((option) =>
        option.toLocaleLowerCase().includes(query),
      );
    };
    const visibleOptionItems = () =>
      visibleOptions().map((option) => ({ label: option, value: option }));
    const descriptionId = `script-input-description-${encodeURIComponent(field.key)}`;
    const errorId = `script-input-error-${encodeURIComponent(field.key)}`;
    const describedBy = () =>
      [
        field.description === undefined ? undefined : descriptionId,
        scriptInputFieldErrorMessage(field.key) === undefined
          ? undefined
          : errorId,
      ]
        .filter((id): id is string => id !== undefined)
        .join(" ") || undefined;

    if (field.type === "boolean") {
      return (
        <div
          class="game-script-inputs-dialog__field"
          data-invalid={hasError() ? "" : undefined}
          data-script-input-key={field.key}
          ref={(element) => setScriptInputFieldRef(field.key, element)}
        >
          <Checkbox
            aria-describedby={describedBy()}
            aria-label={label()}
            checked={value() === true}
            disabled={scriptInputDialogSaving()}
            invalid={hasError()}
            ref={(element) => setScriptInputEditorRef(field.key, element)}
            onInput={(event) =>
              updateScriptInputDraft(field.key, event.currentTarget.checked)
            }
          >
            <span class="game-script-inputs-dialog__checkbox-label-content">
              <span class="game-script-inputs-dialog__checkbox-label-text">
                {label()}
                <Show when={field.required === true}>
                  <span
                    aria-hidden="true"
                    class="game-script-inputs-dialog__field-required game-script-inputs-dialog__field-required--inline"
                  >
                    {" "}
                    *
                  </span>
                </Show>
                <Show when={field.required !== true}>
                  <span class="game-script-inputs-dialog__field-optional game-script-inputs-dialog__field-optional--inline">
                    {" "}
                    (optional)
                  </span>
                </Show>
              </span>
            </span>
          </Checkbox>
          <Show when={field.description}>
            {(description) => (
              <span
                class="game-script-inputs-dialog__description"
                id={descriptionId}
              >
                {description()}
              </span>
            )}
          </Show>
          <Show when={scriptInputFieldErrorMessage(field.key)}>
            {(message) => (
              <span
                class="game-script-inputs-dialog__field-error-msg"
                id={errorId}
              >
                {message()}
              </span>
            )}
          </Show>
        </div>
      );
    }

    return (
      <div
        class="game-script-inputs-dialog__field"
        data-invalid={hasError() ? "" : undefined}
        data-script-input-key={field.key}
        ref={(element) => setScriptInputFieldRef(field.key, element)}
      >
        <Label class="game-script-inputs-dialog__label">
          <span class="game-script-inputs-dialog__label-text">
            {label()}
            <Show when={field.required === true}>
              <span
                aria-hidden="true"
                class="game-script-inputs-dialog__field-required game-script-inputs-dialog__field-required--inline"
              >
                {" "}
                *
              </span>
            </Show>
            <Show when={field.required !== true}>
              <span class="game-script-inputs-dialog__field-optional game-script-inputs-dialog__field-optional--inline">
                {" "}
                (optional)
              </span>
            </Show>
          </span>
        </Label>
        <Show when={field.description}>
          {(description) => (
            <span
              class="game-script-inputs-dialog__description"
              id={descriptionId}
            >
              {description()}
            </span>
          )}
        </Show>
        <Show
          when={field.type === "multi-select"}
          fallback={
            <Show
              when={field.type === "select"}
              fallback={
                <Input
                  aria-describedby={describedBy()}
                  aria-label={label()}
                  disabled={scriptInputDialogSaving()}
                  fullWidth
                  invalid={hasError()}
                  inputMode={field.type === "number" ? "decimal" : undefined}
                  ref={(element) => setScriptInputEditorRef(field.key, element)}
                  type={field.type === "number" ? "number" : "text"}
                  value={String(value() ?? "")}
                  onInput={(event) =>
                    updateScriptInputDraft(field.key, event.currentTarget.value)
                  }
                />
              }
            >
              <Combobox
                class={
                  hasError()
                    ? "game-script-inputs-dialog__combobox--invalid"
                    : undefined
                }
                disabled={scriptInputDialogSaving()}
                inputBehavior="autohighlight"
                items={visibleOptionItems()}
                openOnClick
                value={value() ? [String(value())] : []}
                onInputValueChange={(details) =>
                  setOptionQuery(
                    details.reason === "input-change" ? details.inputValue : "",
                  )
                }
                onValueChange={(details) =>
                  updateScriptInputDraft(field.key, details.value[0] ?? "")
                }
              >
                <ComboboxInput
                  aria-describedby={describedBy()}
                  aria-label={label()}
                  aria-invalid={hasError() ? "true" : undefined}
                  aria-required={field.required === true ? "true" : undefined}
                  clearProps={{ "aria-label": `Clear ${label()}` }}
                  disabled={scriptInputDialogSaving()}
                  placeholder={field.required === true ? "Select a value" : ""}
                  ref={(element) => setScriptInputEditorRef(field.key, element)}
                  showClear={field.required !== true}
                />
                <ComboboxContent>
                  <ComboboxEmpty>No matching options</ComboboxEmpty>
                  <ComboboxList>
                    <For each={visibleOptions()}>
                      {(option) => (
                        <ComboboxItem value={option}>{option}</ComboboxItem>
                      )}
                    </For>
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </Show>
          }
        >
          <div class="game-script-inputs-dialog__multi-select">
            <Combobox
              class={
                hasError()
                  ? "game-script-inputs-dialog__combobox--invalid"
                  : undefined
              }
              closeOnSelect={false}
              disabled={scriptInputDialogSaving()}
              inputBehavior="autohighlight"
              items={visibleOptionItems()}
              multiple
              openOnClick
              value={[...selectedValues()]}
              onInputValueChange={(details) =>
                setOptionQuery(
                  details.reason === "input-change" ? details.inputValue : "",
                )
              }
              onValueChange={(details) =>
                updateScriptInputDraft(field.key, details.value)
              }
            >
              <ComboboxInput
                aria-describedby={describedBy()}
                aria-label={label()}
                aria-invalid={hasError() ? "true" : undefined}
                aria-required={field.required === true ? "true" : undefined}
                clearProps={{ "aria-label": `Clear ${label()}` }}
                disabled={scriptInputDialogSaving()}
                placeholder="Search options..."
                ref={(element) => setScriptInputEditorRef(field.key, element)}
                renderLeadingContent={({ clearValue }) => (
                  <For each={selectedValues()}>
                    {(option) => (
                      <span class="game-script-inputs-dialog__multi-select-value">
                        <span class="game-script-inputs-dialog__multi-select-value-label">
                          {option}
                        </span>
                        <button
                          aria-label={`Remove ${option} from ${label()}`}
                          class="game-script-inputs-dialog__multi-select-remove"
                          disabled={scriptInputDialogSaving()}
                          type="button"
                          onClick={() => {
                            clearValue(option);
                            scriptInputEditorRefs.get(field.key)?.focus();
                          }}
                        >
                          <span class="game-script-inputs-dialog__multi-select-remove-content">
                            <Icon aria-hidden="true" icon="x" />
                          </span>
                        </button>
                      </span>
                    )}
                  </For>
                )}
                showClear={selectedValues().length > 0}
              />
              <ComboboxContent>
                <ComboboxEmpty>No matching options</ComboboxEmpty>
                <ComboboxList>
                  <For each={visibleOptions()}>
                    {(option) => (
                      <ComboboxItem value={option}>{option}</ComboboxItem>
                    )}
                  </For>
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
        </Show>
        <Show when={scriptInputFieldErrorMessage(field.key)}>
          {(message) => (
            <span
              class="game-script-inputs-dialog__field-error-msg"
              id={errorId}
            >
              {message()}
            </span>
          )}
        </Show>
      </div>
    );
  };

  return (
    <main
      class="game-app"
      classList={{ "game-app--topnav-hidden": !effectiveTopNavVisible() }}
      data-platform={platformLabel()}
    >
      <HotkeyStatus announcement={hotkeyStatus.announcement()} />
      <ScriptDialogHost
        request={scriptDialogRequest}
        respond={respondToScriptDialog}
      />
      <ScriptsDialog
        bridge={desktop.scripting}
        inputsAvailable={scriptInputsAvailable()}
        loadedReference={loadedScript()?.reference}
        onChooseFile={chooseScriptFile}
        onCommitRoomNumber={handleCommitScriptRoomNumber}
        onCopyText={(text) => navigator.clipboard.writeText(text)}
        onEditInputs={openScriptInputs}
        onEnqueueScript={enqueueCatalogScript}
        onOpenChange={setScriptsDialogOpen}
        onQueueClear={() => scriptQueue.clear()}
        onQueueEditInputs={(entryId) => scriptQueue.editInputs(entryId)}
        onQueueMove={(entryId, offset) => scriptQueue.move(entryId, offset)}
        onQueueRemove={(entryId) => scriptQueue.remove(entryId)}
        onQueueRunNext={() => scriptQueue.runNext()}
        onQueueStart={() => scriptQueue.start()}
        onQueueStop={() => scriptQueue.cancel("User stopped the queue")}
        onRetryOptionsSave={handleRetryScriptOptionsSave}
        onSelectRoomPolicy={handleSelectScriptRoomPolicy}
        onSelectScript={selectCatalogScript}
        onSetRoomNumberDraft={(value) => {
          setScriptRoomNumberDraft(value);
          setScriptRoomNumberError("");
        }}
        onToggleRestartAfterReconnect={handleToggleScriptRestartAfterReconnect}
        onToggleSafeStartStop={handleToggleScriptSafeStartStop}
        onToggleScript={toggleScript}
        loggedIn={playerLoggedIn()}
        open={scriptsDialogOpen()}
        optionsReady={scriptReady()}
        optionsSaveStatus={scriptOptionsSaveStatus()}
        queueState={scriptQueueState()}
        restartAfterReconnect={scriptRestartAfterReconnect()}
        roomNumberDraft={scriptRoomNumberDraft()}
        roomNumberError={scriptRoomNumberError()}
        roomPolicy={scriptRoomPolicy()}
        safeStartStop={scriptSafeStartStop()}
        scriptBusy={scriptBusy()}
        scriptLoaded={scriptControlAvailable()}
        scriptRunning={scriptControlActive()}
        scriptStatus={scriptStatus()}
      />
      <Dialog
        open={scriptInputDialogOpen()}
        onOpenChange={(details) => {
          if (details.open) {
            setScriptInputDialogOpen(true);
            return;
          }

          cancelScriptInputsDialog();
        }}
      >
        <DialogContent
          class="game-script-inputs-dialog"
          closeProps={{ disabled: scriptInputDialogSaving() }}
          showCloseButton
        >
          <DialogHeader>
            <DialogTitle>
              {isRequiredScriptInputsDialog(scriptInputDialogMode())
                ? "Script inputs required"
                : scriptInputDialogMode() === "queue-edit"
                  ? "Queue script inputs"
                  : scriptInputDialogMode().startsWith("queue-")
                    ? "Queue inputs required"
                    : "Script inputs"}
            </DialogTitle>
            <DialogDescription>
              {scriptInputDialogScriptName()}
            </DialogDescription>
          </DialogHeader>
          <Show when={scriptInputDialogError()}>
            {(error) => (
              <ScriptInputsErrorAlert
                error={error()}
                onFocusField={focusScriptInputField}
              />
            )}
          </Show>
          <div class="game-script-inputs-dialog__fields">
            <div class="game-script-inputs-dialog__field-list">
              <For each={getScriptInputsDefinition()?.fields ?? []}>
                {renderScriptInputField}
              </For>
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={scriptInputDialogSaving()}
              size="sm"
              type="button"
              variant="outline"
              onClick={cancelScriptInputsDialog}
            >
              Cancel
            </Button>
            <Button
              disabled={scriptInputDialogSaving()}
              size="sm"
              type="button"
              onClick={() => void persistScriptInputs()}
            >
              {isRequiredScriptInputsDialog(scriptInputDialogMode())
                ? "Save and Start"
                : scriptInputDialogMode() === "queue-add"
                  ? "Add to queue"
                  : scriptInputDialogMode() === "queue-preflight"
                    ? "Save and continue"
                    : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={scriptReplacementDialogOpen()}
        onOpenChange={(details) => setScriptReplacementDialogOpen(details.open)}
      >
        <AlertDialogContent showCloseButton={false}>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the running script?</AlertDialogTitle>
            <AlertDialogDescription>
              Choose a replacement file. The current script will keep running
              until the new file loads successfully.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void chooseScriptFile(true)}
              variant="destructive"
            >
              Choose replacement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={queueReplacementDialogOpen()}
        onOpenChange={(details) => {
          if (!details.open) settleQueueReplacementConfirmation(false);
        }}
      >
        <AlertDialogContent showCloseButton={false}>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the running script?</AlertDialogTitle>
            <AlertDialogDescription>
              The queue is ready. Stop the current script and start the queue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => settleQueueReplacementConfirmation(false)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => settleQueueReplacementConfirmation(true)}
              variant="destructive"
            >
              Stop and start queue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={fatalScriptAlertOpen()}
        onOpenChange={(details) => {
          setFatalScriptAlertOpen(details.open);
          if (!details.open) {
            setFatalScriptAlertCopied(false);
          }
        }}
      >
        <AlertDialogContent class="game-script-error-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Script failed</AlertDialogTitle>
            <AlertDialogDescription>
              <span class="game-script-error-dialog__source">
                <span>{fatalScriptAlert()?.sourceName ?? "script"}</span>
                <Show when={fatalScriptAlert()?.sourcePath}>
                  {(path) => (
                    <TooltipIconButton
                      aria-label="Open script file"
                      class="game-script-error-dialog__open-source"
                      onClick={() => {
                        void desktop.scripting
                          .openPath(path())
                          .catch((error) => {
                            console.error("Failed to open script file", error);
                          });
                      }}
                      portal={false}
                      positioning={{ placement: "right" }}
                      size="icon-xs"
                      tooltip="Open script file"
                      variant="ghost"
                    >
                      <Icon icon="external_link" class="button__icon" />
                    </TooltipIconButton>
                  )}
                </Show>
              </span>
              <span class="game-script-error-dialog__message">
                {fatalScriptAlert()?.message ?? "Script failed"}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Show when={fatalScriptAlert()?.detailsText}>
            {(detailsText) => (
              <Accordion
                collapsible
                class="game-script-error-dialog__accordion"
              >
                <AccordionItem value="stack-trace">
                  <AccordionTrigger>Stack trace</AccordionTrigger>
                  <AccordionContent>
                    <pre class="game-script-error-dialog__stack">
                      {detailsText()}
                    </pre>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </Show>
          <AlertDialogFooter>
            <Show when={fatalScriptAlert()?.detailsText}>
              <Button
                class="game-script-error-dialog__copy"
                onClick={() => void copyFatalScriptAlertDetails()}
                size="sm"
                variant="outline"
              >
                <Icon
                  icon={fatalScriptAlertCopied() ? "check" : "copy"}
                  class="button__icon"
                />
                {fatalScriptAlertCopied() ? "Copied" : "Copy stack trace"}
              </Button>
            </Show>
            <AlertDialogAction size="sm">OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Show when={effectiveTopNavVisible()}>
        <TopNav
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          hotkeyBindings={() => settings().hotkeys.bindings}
          hotkeyPlatform={props.platform}
          gameLoaded={gameLoaded}
          playerReady={playerReady}
          optionItems={optionItems}
          walkSpeed={walkSpeed}
          setWalkSpeed={setWalkSpeed}
          handleSetWalkSpeed={handleSetWalkSpeed}
          frameRate={frameRate}
          setFrameRate={setFrameRate}
          handleSetFrameRate={handleSetFrameRate}
          handleReloadMap={handleReloadMap}
          handleSetSpawnPoint={handleSetSpawnPoint}
          customName={customName}
          customNameConfigured={() => flashSettings().customNameConfigured}
          setCustomName={setCustomName}
          handleSetCustomName={handleSetCustomName}
          handleResetCustomName={handleResetCustomName}
          customGuild={customGuild}
          customGuildConfigured={() => flashSettings().customGuildConfigured}
          setCustomGuild={setCustomGuild}
          handleSetCustomGuild={handleSetCustomGuild}
          handleResetCustomGuild={handleResetCustomGuild}
          autoAttackEnabled={autoAttackEnabled}
          autoAttackProfileLabel={autoAttackProfileLabel}
          autoAttackConfiguredProfileLabel={autoAttackConfiguredProfileLabel}
          autoAttackLastError={autoAttackLastError}
          autoAttackWarnings={autoAttackWarnings}
          autoAttackTargetPriority={autoAttackTargetPriority}
          setAutoAttackTargetPriority={setAutoAttackTargetPriority}
          combatProfiles={() => combatProfileLibrary().profiles}
          selectedAutoAttackProfileId={selectedAutoAttackProfileId}
          handleToggleAutoAttack={handleToggleAutoAttack}
          handleSelectAutoAttackProfile={handleSelectAutoAttackProfile}
          scriptLoaded={scriptControlAvailable}
          scriptRunning={scriptControlActive}
          scriptTogglePending={scriptTogglePending}
          scriptOptionsReady={scriptReady}
          openScripts={openScripts}
          toggleScript={toggleScript}
          autoZoneEnabled={autoZoneEnabled}
          autoZoneMap={autoZoneMap}
          handleToggleAutoZone={handleToggleAutoZone}
          handleSelectAutoZoneMap={handleSelectAutoZoneMap}
          autoReloginEnabled={autoReloginEnabled}
          autoReloginCaptured={autoReloginCaptured}
          autoReloginAttempting={autoReloginAttempting}
          autoReloginWaitingDelay={autoReloginWaitingDelay}
          autoReloginToggling={autoReloginToggling}
          autoReloginDelaySeconds={autoReloginDelaySeconds}
          setAutoReloginDelaySeconds={setAutoReloginDelaySeconds}
          autoReloginServer={autoReloginServer}
          autoReloginServers={autoReloginServers}
          autoReloginLastError={autoReloginLastError}
          autoReloginAttemptsRemaining={autoReloginAttemptsRemaining}
          handleToggleAutoRelogin={handleToggleAutoRelogin}
          handleRefreshAutoReloginServers={refreshAutoReloginServers}
          handleSelectAutoReloginServer={handleSelectAutoReloginServer}
          handleSetAutoReloginDelay={handleSetAutoReloginDelay}
          cells={cells}
          pads={pads}
          validPads={validPads}
          selectedCell={selectedCell}
          selectedPad={selectedPad}
          travelBusy={travelBusy}
          handleRefreshTravelOptions={refreshTravelOptions}
          handleSelectCell={handleSelectCell}
          handleSelectPad={handleSelectPad}
          handleOpenBank={handleOpenBank}
          handleOpenWindow={handleOpenWindow}
        />
      </Show>

      <Show when={gameLoaderMounted()}>
        <section
          id="loader-container"
          class="game-loader"
          classList={{ "game-loader--hidden": gameLoaded() }}
          aria-busy={gameLoaded() ? undefined : "true"}
          aria-hidden={gameLoaded() ? "true" : undefined}
          onTransitionEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.propertyName === "opacity" &&
              gameLoaded()
            ) {
              setGameLoaderMounted(false);
            }
          }}
        >
          <div class="game-loader__content">
            <Spinner class="game-loader__spinner" size="xl" />
            <span
              aria-label="Game loading progress"
              aria-valuemax="100"
              aria-valuemin="0"
              aria-valuenow={progress()}
              class="game-loader__progress"
              role="progressbar"
            >
              {progress()}%
            </span>
            <Show when={gameLoadDelayed()}>
              <div class="game-loader__recovery">
                <div class="game-loader__recovery-copy">
                  <strong class="game-loader__recovery-title">
                    Still loading...
                  </strong>
                  <span
                    class="game-loader__recovery-description"
                    id="game-load-recovery-description"
                  >
                    {gameLoadRecoveryError() ||
                      "The game is taking longer than expected. You can keep waiting or reload it."}
                  </span>
                </div>
                <Button
                  aria-describedby="game-load-recovery-description"
                  loading={gameLoadRecoveryPending()}
                  onClick={() => void reloadGameAfterLoadStall()}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {activeAccountLaunchPayload()?.script === undefined
                    ? "Reload game"
                    : "Reload without script"}
                </Button>
              </div>
            </Show>
          </div>
        </section>

        <VisuallyHidden aria-atomic="true" role="status">
          {gameLoadRecoveryError() ||
            (gameLoadDelayed()
              ? "Still loading. The game is taking longer than expected. You can keep waiting or reload it."
              : "")}
        </VisuallyHidden>
      </Show>

      <section
        id="game-container"
        class="game-viewport"
        classList={{ "game-viewport--loaded": gameLoaded() }}
      >
        <div class="game-visual-cover" aria-hidden="true" />
      </section>

      <Show when={flashSettings().renderingMode === "minimal"}>
        <section
          aria-describedby="minimal-rendering-description"
          aria-labelledby="minimal-rendering-title"
          class="game-minimal-rendering"
        >
          <div class="game-minimal-rendering__content">
            <h1
              class="game-minimal-rendering__title"
              id="minimal-rendering-title"
            >
              Minimal rendering
            </h1>
            <p
              class="game-minimal-rendering__description"
              id="minimal-rendering-description"
              role="status"
            >
              The game and scripts keep running while using fewer resources.
            </p>
            <Button
              disabled={renderingModePending()}
              onClick={handleRestoreRenderingMode}
              size="default"
              variant="secondary"
            >
              Resume rendering
            </Button>
          </div>
        </section>
      </Show>

      <Show when={desktop.debug}>
        <DevDebugEvaluator />
      </Show>
    </main>
  );
}

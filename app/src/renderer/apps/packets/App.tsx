import { createHotkey } from "@tanstack/solid-hotkeys";
import { createVirtualizer, type VirtualItem } from "@tanstack/solid-virtual";
import {
  Icon,
  HelpTooltip,
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  IconButton,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  PillButton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  TooltipIconButton,
} from "@lucent/ui";
import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import {
  PACKET_LOG_BUFFER_LIMIT,
  PACKET_PLACEHOLDER_DEFINITIONS,
  PACKET_QUEUE_DEFAULT_DELAY_MS,
  PACKET_QUEUE_MAX_DELAY_MS,
  PACKET_QUEUE_MIN_DELAY_MS,
  PacketCaptureTypes,
  PacketSendTargets,
  clampPacketQueueDelay,
  isPacketSendTarget,
  normalizePacketText,
  type PacketCapturedPayload,
  type PacketCaptureType,
  type PacketQueuePayload,
  type PacketSendPayload,
  type PacketSendTarget,
  type PacketsStatusPayload,
} from "../../../shared/packets";
import { selectDesktopBridge } from "../../../shared/desktopBridge";
import { downloadText } from "../../lib/download";
import { splitTextMatches } from "../../lib/text";
import { formatPacketLogEntries, formatPacketTimestamp } from "./logFormatting";
import { appendPacketLogBatch } from "./packetLogBuffer";
import {
  QUEUE_PACKET_EMPTY_ERROR,
  isValidQueuePacketDraft,
  replaceQueuePacketAt,
} from "./queueState";

export type ActiveTab = "log" | "send";
const LOG_ROW_HEIGHT_COMPACT = 30;
const LOG_ROW_OVERSCAN = 8;
const LOG_ROW_WRAPPED_APPROX_CHAR_WIDTH = 7.2;
const LOG_ROW_WRAPPED_FIXED_WIDTH = 110;
const LOG_ROW_WRAPPED_FIXED_WIDTH_WITH_TIMESTAMP = 210;
const LOG_ROW_WRAPPED_TEXT_LINE_HEIGHT = 18;
const LOG_ROW_WRAPPED_VERTICAL_CHROME = 7;
const LOG_ROW_WRAPPED_MAX_HEIGHT = 220;

interface PacketLogEntry {
  readonly id: string;
  readonly raw: string;
  readonly text: string;
  readonly timestamp: number;
  readonly type: PacketCaptureType;
}

interface PacketLogEmptyState {
  readonly description?: string;
  readonly title: string;
}

interface PacketLogVirtualRow {
  readonly entry: PacketLogEntry;
  readonly item: VirtualItem;
}

const packetTypeLabels: Record<PacketCaptureType, string> = {
  client: "Client",
  extension: "Extension",
  server: "Server",
};

const sendTargetLabels: Record<PacketSendTarget, string> = {
  "client-json": "Client JSON",
  "client-str": "Client str",
  "client-xml": "Client XML",
  "server-json": "Server JSON",
  "server-string": "Server string",
};

const sendTargetOptions = PacketSendTargets.map((target) => ({
  label: sendTargetLabels[target],
  value: target,
}));

const packetPlaceholderHelp = `Placeholders resolve when packets are sent: ${PACKET_PLACEHOLDER_DEFINITIONS.map(
  (definition) => definition.token,
).join(", ")}.`;

export interface PacketsViewFixture {
  readonly activeTab?: ActiveTab;
  readonly autoScroll?: boolean;
  readonly captureRunning?: boolean;
  readonly delayMs?: string;
  readonly error?: string;
  readonly filters?: Readonly<Partial<Record<PacketCaptureType, boolean>>>;
  readonly notice?: string;
  readonly packets?: readonly PacketCapturedPayload[];
  readonly queue?: readonly string[];
  readonly queueRunning?: boolean;
  readonly search?: string;
  readonly selectedQueueIndex?: number | null;
  readonly sendTarget?: PacketSendTarget;
  readonly sendText?: string;
  readonly showTimestamps?: boolean;
  readonly wrapPackets?: boolean;
}

export interface PacketsViewProps {
  readonly fixture?: PacketsViewFixture;
  readonly getStatus?: () => Promise<PacketsStatusPayload>;
  readonly onCopyText: (text: string) => Promise<void>;
  readonly onCaptured?: (
    listener: (payload: PacketCapturedPayload) => void,
  ) => () => void;
  readonly onSend?: (payload: PacketSendPayload) => Promise<void>;
  readonly onStartCapture?: () => Promise<void>;
  readonly onStartQueue?: (payload: PacketQueuePayload) => Promise<void>;
  readonly onStatus?: (
    listener: (payload: PacketsStatusPayload) => void,
  ) => () => void;
  readonly onStopCapture?: () => Promise<void>;
  readonly onStopQueue?: () => Promise<void>;
}

const estimateWrappedLogRowHeight = (
  entry: PacketLogEntry,
  viewportWidth: number,
  includeTimestamp: boolean,
): number => {
  const fixedWidth = includeTimestamp
    ? LOG_ROW_WRAPPED_FIXED_WIDTH_WITH_TIMESTAMP
    : LOG_ROW_WRAPPED_FIXED_WIDTH;
  const packetWidth = Math.max(80, viewportWidth - fixedWidth);
  const charsPerLine = Math.max(
    1,
    Math.floor(packetWidth / LOG_ROW_WRAPPED_APPROX_CHAR_WIDTH),
  );
  const textLineCount = entry.text
    .split(/\r\n|\r|\n/)
    .reduce(
      (count, line) =>
        count + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0,
    );

  return Math.min(
    LOG_ROW_WRAPPED_MAX_HEIGHT,
    Math.max(
      LOG_ROW_HEIGHT_COMPACT,
      Math.ceil(
        textLineCount * LOG_ROW_WRAPPED_TEXT_LINE_HEIGHT +
          LOG_ROW_WRAPPED_VERTICAL_CHROME,
      ),
    ),
  );
};

function PacketSenderLabelHelp(): JSX.Element {
  return (
    <span class="packets-sender__label-help">
      <Label for="packet-input">Packet</Label>
      <HelpTooltip
        aria-label="Packet placeholders"
        tooltip={packetPlaceholderHelp}
      />
    </span>
  );
}

/** Renders packet capture and send state without requiring an IPC bridge. */
export function PacketsView(props: PacketsViewProps): JSX.Element {
  let packetSearchInput: HTMLInputElement | undefined;
  let senderTextarea: HTMLTextAreaElement | undefined;
  let editingQueueTextarea: HTMLTextAreaElement | undefined;

  const [activeTab, setActiveTab] = createSignal<ActiveTab>(
    props.fixture?.activeTab ?? "log",
  );
  const [captureRunning, setCaptureRunning] = createSignal(
    props.fixture?.captureRunning ?? false,
  );
  const [queueRunning, setQueueRunning] = createSignal(
    props.fixture?.queueRunning ?? false,
  );
  const [packets, setPackets] = createSignal<readonly PacketLogEntry[]>(
    (props.fixture?.packets ?? []).map((packet, index) => ({
      id: `fixture-${index}`,
      raw: packet.packet,
      text: normalizePacketText(packet.packet, packet.type),
      timestamp: packet.capturedAt,
      type: packet.type,
    })),
  );
  const [search, setSearch] = createSignal(props.fixture?.search ?? "");
  const [showTimestamps, setShowTimestamps] = createSignal(
    props.fixture?.showTimestamps ?? false,
  );
  const [autoScroll, setAutoScroll] = createSignal(
    props.fixture?.autoScroll ?? true,
  );
  const [wrapPackets, setWrapPackets] = createSignal(
    props.fixture?.wrapPackets ?? false,
  );
  const [filters, setFilters] = createSignal<
    Record<PacketCaptureType, boolean>
  >({
    client: true,
    extension: true,
    server: false,
    ...props.fixture?.filters,
  });
  const [sendText, setSendText] = createSignal(props.fixture?.sendText ?? "");
  const [sendTarget, setSendTarget] = createSignal<PacketSendTarget>(
    props.fixture?.sendTarget ?? "server-string",
  );
  const [delayMs, setDelayMs] = createSignal(
    props.fixture?.delayMs ?? String(PACKET_QUEUE_DEFAULT_DELAY_MS),
  );
  const [queue, setQueue] = createSignal<readonly string[]>(
    props.fixture?.queue ?? [],
  );
  const [selectedQueueIndex, setSelectedQueueIndex] = createSignal<
    number | null
  >(props.fixture?.selectedQueueIndex ?? null);
  const [editingQueueIndex, setEditingQueueIndex] = createSignal<number | null>(
    null,
  );
  const [editingQueueText, setEditingQueueText] = createSignal("");
  const [confirmKeyboardSendOpen, setConfirmKeyboardSendOpen] =
    createSignal(false);
  const [pendingKeyboardSendPacket, setPendingKeyboardSendPacket] =
    createSignal<string | null>(null);
  const [error, setError] = createSignal(props.fixture?.error ?? "");
  const [notice, setNotice] = createSignal(props.fixture?.notice ?? "");
  const [logViewportWidth, setLogViewportWidth] = createSignal(0);
  const [allPacketsCopied, setAllPacketsCopied] = createSignal(false);
  let logViewport: HTMLDivElement | undefined;
  let allPacketsCopiedTimer: number | undefined;
  let capturedPacketFrame: number | undefined;
  let pendingCapturedPackets: PacketLogEntry[] = [];
  let scrollAfterCapturedPacketFlush = false;

  createHotkey(
    "/",
    (event) => {
      if (event.repeat) {
        return;
      }

      packetSearchInput?.focus();
      packetSearchInput?.select();
    },
    {
      eventType: "keydown",
      conflictBehavior: "replace",
      ignoreInputs: true,
    },
  );

  const packetViews = createMemo(() => {
    const activeFilters = filters();
    const query = search().trim().toLocaleLowerCase();
    const source: PacketLogEntry[] = [];
    const filtered: PacketLogEntry[] = [];

    for (const entry of packets()) {
      if (!activeFilters[entry.type]) {
        continue;
      }

      source.push(entry);
      if (query !== "" && entry.text.toLocaleLowerCase().includes(query)) {
        filtered.push(entry);
      }
    }

    return {
      filtered: query === "" ? source : filtered,
      source,
    };
  });
  const sourceFilteredPackets = (): readonly PacketLogEntry[] =>
    packetViews().source;
  const filteredPackets = (): readonly PacketLogEntry[] =>
    packetViews().filtered;

  const logEmptyState = createMemo<PacketLogEmptyState>(() => {
    if (packets().length === 0) {
      return {
        title: captureRunning() ? "Waiting for packets" : "Capture is stopped",
      };
    }

    const hasSearch = search().trim() !== "";
    const hasTypeFilter = PacketCaptureTypes.some((type) => !filters()[type]);

    if (hasSearch && hasTypeFilter) {
      return {
        title: "No packets match these filters",
      };
    }

    if (hasSearch) {
      return {
        title: "No packets match this search",
      };
    }

    if (hasTypeFilter) {
      return {
        description:
          "Enable Client, Server, or Extension to show captured packets.",
        title: "All captured packets are hidden",
      };
    }

    return {
      title: captureRunning() ? "Waiting for packets" : "Capture is stopped",
    };
  });

  const stats = createMemo(() => {
    const counts: Record<PacketCaptureType, number> = {
      client: 0,
      extension: 0,
      server: 0,
    };
    for (const entry of packets()) {
      counts[entry.type] += 1;
    }
    return counts;
  });

  const parsedDelayMs = createMemo(() => clampPacketQueueDelay(delayMs()));
  const trimmedSendText = createMemo(() => sendText().trim());
  const hasUnsavedQueueEdit = createMemo(() => editingQueueIndex() !== null);
  const canSend = createMemo(
    () => trimmedSendText().length > 0 && !queueRunning(),
  );
  const canQueue = createMemo(
    () => queue().length > 0 && !queueRunning() && !hasUnsavedQueueEdit(),
  );
  const logVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return filteredPackets().length;
    },
    estimateSize: (index) => {
      const entry = filteredPackets()[index];
      if (!entry || !wrapPackets()) {
        return LOG_ROW_HEIGHT_COMPACT;
      }

      return estimateWrappedLogRowHeight(
        entry,
        logViewportWidth(),
        showTimestamps(),
      );
    },
    getItemKey: (index) => filteredPackets()[index]?.id ?? index,
    getScrollElement: () => logViewport ?? null,
    measureElement: (element) => {
      if (!wrapPackets()) {
        return LOG_ROW_HEIGHT_COMPACT;
      }

      const index = Number(element.getAttribute("data-index"));
      const entry = Number.isInteger(index) ? filteredPackets()[index] : null;
      return entry
        ? estimateWrappedLogRowHeight(
            entry,
            logViewportWidth(),
            showTimestamps(),
          )
        : LOG_ROW_WRAPPED_MAX_HEIGHT;
    },
    overscan: LOG_ROW_OVERSCAN,
    useAnimationFrameWithResizeObserver: true,
  });

  const logVirtualRows = createMemo<readonly PacketLogVirtualRow[]>(() => {
    const entries = filteredPackets();
    const rows: PacketLogVirtualRow[] = [];

    for (const item of logVirtualizer.getVirtualItems()) {
      if (!item) {
        continue;
      }

      const entry = entries[item.index];
      if (entry) {
        rows.push({ entry, item });
      }
    }

    return rows;
  });

  createEffect(() => {
    wrapPackets();
    showTimestamps();
    Math.round(logViewportWidth());
    logVirtualizer.measure();
  });

  const setOperationError = (message: string, cause: unknown): void => {
    console.error(message, cause);
    setNotice("");
    setError(cause instanceof Error ? cause.message : message);
  };

  const toggleFilter = (type: PacketCaptureType): void => {
    setFilters((current) => ({ ...current, [type]: !current[type] }));
  };

  const flushCapturedPackets = (): void => {
    capturedPacketFrame = undefined;
    const batch = pendingCapturedPackets;
    const shouldScroll = scrollAfterCapturedPacketFlush;
    pendingCapturedPackets = [];
    scrollAfterCapturedPacketFlush = false;

    if (batch.length === 0) {
      return;
    }

    setPackets((current) =>
      appendPacketLogBatch(current, batch, PACKET_LOG_BUFFER_LIMIT),
    );

    if (shouldScroll) {
      const lastIndex = filteredPackets().length - 1;
      if (lastIndex >= 0) {
        logVirtualizer.scrollToIndex(lastIndex, { align: "end" });
      }
    }
  };

  const addCapturedPacket = (payload: PacketCapturedPayload): void => {
    pendingCapturedPackets.push({
      id: crypto.randomUUID(),
      raw: payload.packet,
      text: normalizePacketText(payload.packet, payload.type),
      timestamp: payload.capturedAt,
      type: payload.type,
    });
    scrollAfterCapturedPacketFlush ||= autoScroll();

    if (capturedPacketFrame === undefined) {
      capturedPacketFrame = window.requestAnimationFrame(flushCapturedPackets);
    }
  };

  const toggleCapture = async (): Promise<void> => {
    setError("");
    setNotice("");
    const nextRunning = !captureRunning();
    setCaptureRunning(nextRunning);

    try {
      if (nextRunning) {
        await props.onStartCapture?.();
      } else {
        await props.onStopCapture?.();
      }
    } catch (cause) {
      setCaptureRunning(!nextRunning);
      setOperationError("Packet capture request failed", cause);
    }
  };

  const clearPackets = (): void => {
    pendingCapturedPackets = [];
    scrollAfterCapturedPacketFlush = false;
    setPackets([]);
  };

  const markAllPacketsCopied = (): void => {
    if (allPacketsCopiedTimer !== undefined) {
      window.clearTimeout(allPacketsCopiedTimer);
    }

    setAllPacketsCopied(true);
    allPacketsCopiedTimer = window.setTimeout(() => {
      setAllPacketsCopied(false);
      allPacketsCopiedTimer = undefined;
    }, 900);
  };

  const copyText = async (value: string): Promise<boolean> => {
    try {
      await props.onCopyText(value);
      setNotice("");
      setError("");
      return true;
    } catch (cause) {
      setOperationError("Copy failed", cause);
      return false;
    }
  };

  const normalizeDelayInput = (): void => {
    setDelayMs(String(parsedDelayMs()));
  };

  const copyAllCaptured = (): void => {
    const content = formatPacketLogEntries(
      sourceFilteredPackets(),
      showTimestamps(),
    );
    if (content) {
      void copyText(content).then((copied) => {
        if (copied) {
          markAllPacketsCopied();
        }
      });
    }
  };

  const exportVisible = (): void => {
    const content = formatPacketLogEntries(filteredPackets(), true);
    if (content) {
      downloadText("packets.txt", content);
    }
  };

  const usePacketInSender = (entry: PacketLogEntry): void => {
    setSendText(entry.text);
    setActiveTab("send");
    requestAnimationFrame(() => senderTextarea?.focus());
  };

  const addPacketToQueue = (entry: PacketLogEntry): void => {
    if (queueRunning()) {
      return;
    }

    setQueue((current) => [...current, entry.text]);
    setNotice("");
    setError("");
  };

  const sendPacket = async (packet = trimmedSendText()): Promise<void> => {
    if (!packet || queueRunning()) {
      return;
    }

    setError("");
    setNotice("");
    try {
      await props.onSend?.({
        packet,
        target: sendTarget(),
      });
    } catch (cause) {
      setOperationError("Packet send failed", cause);
    }
  };

  const addQueuePacket = (): void => {
    const packet = trimmedSendText();
    if (!packet || queueRunning()) {
      return;
    }

    setQueue((current) => [...current, packet]);
    setSendText("");
  };

  const requestKeyboardSend = (): void => {
    const packet = trimmedSendText();
    if (!packet || queueRunning()) {
      return;
    }

    setPendingKeyboardSendPacket(packet);
    setConfirmKeyboardSendOpen(true);
  };

  const confirmKeyboardSend = (): void => {
    const packet = pendingKeyboardSendPacket();
    setPendingKeyboardSendPacket(null);
    setConfirmKeyboardSendOpen(false);
    if (packet) {
      void sendPacket(packet);
    }
  };

  const handleSenderKeyDown: JSX.EventHandler<
    HTMLTextAreaElement,
    KeyboardEvent
  > = (event) => {
    if (event.key !== "Enter" || event.isComposing || event.shiftKey) {
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      requestKeyboardSend();
      return;
    }

    if (event.altKey) {
      return;
    }

    event.preventDefault();
    addQueuePacket();
  };

  const cancelQueuePacketEdit = (): void => {
    setEditingQueueIndex(null);
    setEditingQueueText("");
    setError("");
    setNotice("");
  };

  const focusEditingQueueTextarea = (): void => {
    requestAnimationFrame(() => {
      editingQueueTextarea?.focus();
      editingQueueTextarea?.select();
    });
  };

  const startQueuePacketEditAt = (index: number): void => {
    const currentEditingIndex = editingQueueIndex();
    if (queueRunning() || currentEditingIndex !== null) {
      return;
    }

    const packet = queue()[index];
    if (packet === undefined) {
      return;
    }

    setEditingQueueIndex(index);
    setEditingQueueText(packet);
    setSelectedQueueIndex(index);
    setError("");
    setNotice("");
    focusEditingQueueTextarea();
  };

  const startQueuePacketEdit = (): void => {
    const index = selectedQueueIndex();
    if (index !== null) {
      startQueuePacketEditAt(index);
    }
  };

  const saveQueuePacketEdit = (): void => {
    const index = editingQueueIndex();
    if (index === null || queueRunning()) {
      return;
    }

    const packet = editingQueueText().trim();
    if (!isValidQueuePacketDraft(packet)) {
      setNotice("");
      setError(QUEUE_PACKET_EMPTY_ERROR);
      focusEditingQueueTextarea();
      return;
    }

    setQueue((current) => replaceQueuePacketAt(current, index, packet));
    setSelectedQueueIndex(index);
    cancelQueuePacketEdit();
    setError("");
    setNotice("");
  };

  const handleQueueEditorKeyDown: JSX.EventHandler<
    HTMLTextAreaElement,
    KeyboardEvent
  > = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelQueuePacketEdit();
      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      saveQueuePacketEdit();
    }
  };

  const removeQueuePacket = (): void => {
    const index = selectedQueueIndex();
    if (index === null || queueRunning() || hasUnsavedQueueEdit()) {
      return;
    }

    setQueue((current) =>
      current.filter((_, currentIndex) => currentIndex !== index),
    );
    setSelectedQueueIndex(null);
  };

  const moveQueuePacket = (offset: -1 | 1): void => {
    const index = selectedQueueIndex();
    const current = queue();
    if (index === null || queueRunning() || hasUnsavedQueueEdit()) {
      return;
    }

    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= current.length) {
      return;
    }

    const next = [...current];
    const [packet] = next.splice(index, 1);
    if (packet === undefined) {
      return;
    }
    next.splice(nextIndex, 0, packet);
    setQueue(next);
    setSelectedQueueIndex(nextIndex);
  };

  const clearQueue = (): void => {
    if (queueRunning() || hasUnsavedQueueEdit()) {
      return;
    }
    setQueue([]);
    setSelectedQueueIndex(null);
  };

  const startQueue = async (): Promise<void> => {
    if (!canQueue()) {
      return;
    }

    setQueueRunning(true);
    setError("");
    setNotice("");
    try {
      await props.onStartQueue?.({
        delayMs: parsedDelayMs(),
        packets: queue(),
        target: sendTarget(),
      });
    } catch (cause) {
      setQueueRunning(false);
      setOperationError("Packet queue start failed", cause);
    }
  };

  const stopQueue = async (): Promise<void> => {
    if (!queueRunning()) {
      return;
    }

    setQueueRunning(false);
    try {
      await props.onStopQueue?.();
    } catch (cause) {
      setQueueRunning(true);
      setOperationError("Packet queue stop failed", cause);
    }
  };

  const handleRuntimeStatus = (status: {
    readonly captureRunning: boolean;
    readonly queueRunning: boolean;
    readonly stoppedReason?: string;
  }): void => {
    setCaptureRunning(status.captureRunning);
    setQueueRunning(status.queueRunning);
    if (status.queueRunning) {
      cancelQueuePacketEdit();
    }
    if (status.stoppedReason) {
      setNotice(status.stoppedReason);
    }
  };

  const updateLogViewportMetrics = (): void => {
    if (!logViewport) {
      return;
    }

    setLogViewportWidth(logViewport.clientWidth);
  };

  const renderPacketText = (text: string): JSX.Element => {
    const query = search().trim();
    if (query === "") {
      return text;
    }

    return (
      <For each={splitTextMatches(text, query)}>
        {(segment) =>
          segment.match ? (
            <mark class="packets-log-row__match">{segment.text}</mark>
          ) : (
            segment.text
          )
        }
      </For>
    );
  };

  const PacketLogRowView = (props: {
    readonly entry: PacketLogEntry;
  }): JSX.Element => {
    return (
      <ContextMenu>
        <ContextMenuTrigger
          aria-label={`${packetTypeLabels[props.entry.type]} packet. Open context menu for actions.`}
          class="packets-log-row"
          tabIndex={0}
          title="Right-click for packet actions"
        >
          <div
            class="packets-log-row__content"
            classList={{
              "packets-log-row__content--timestamp": showTimestamps(),
              "packets-log-row__content--wrapped": wrapPackets(),
            }}
          >
            <Show when={showTimestamps()}>
              <span class="packets-log-row__time">
                {formatPacketTimestamp(props.entry.timestamp)}
              </span>
            </Show>
            <span
              class={`packets-log-row__type packets-log-row__type--${props.entry.type}`}
            >
              {packetTypeLabels[props.entry.type]}
            </span>
            <span class="packets-log-row__packet">
              {renderPacketText(props.entry.text)}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => void copyText(props.entry.text)}
            value="copy"
          >
            Copy packet
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => usePacketInSender(props.entry)}
            value="sender"
          >
            Use in sender
          </ContextMenuItem>
          <ContextMenuItem
            disabled={queueRunning()}
            onSelect={() => addPacketToQueue(props.entry)}
            value="queue"
          >
            Add to queue
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  onMount(() => {
    let disposed = false;
    let receivedStatus = false;
    const unsubscribeCaptured = props.onCaptured?.(addCapturedPacket);
    const unsubscribeStatus = props.onStatus?.((status) => {
      receivedStatus = true;
      handleRuntimeStatus(status);
    });
    if (props.getStatus !== undefined) {
      void props
        .getStatus()
        .then((status) => {
          if (!disposed && !receivedStatus) {
            handleRuntimeStatus(status);
          }
        })
        .catch((cause: unknown) => {
          if (!disposed) {
            setOperationError("Failed to load packet runtime status", cause);
          }
        });
    }
    const resizeObserver = new ResizeObserver(updateLogViewportMetrics);
    if (logViewport) {
      resizeObserver.observe(logViewport);
      updateLogViewportMetrics();
    }

    onCleanup(() => {
      disposed = true;
      if (allPacketsCopiedTimer !== undefined) {
        window.clearTimeout(allPacketsCopiedTimer);
      }
      if (capturedPacketFrame !== undefined) {
        window.cancelAnimationFrame(capturedPacketFrame);
      }
      pendingCapturedPackets = [];

      unsubscribeCaptured?.();
      unsubscribeStatus?.();
      resizeObserver.disconnect();
      if (captureRunning() && props.onStopCapture !== undefined) {
        void props.onStopCapture().catch((cause: unknown) => {
          console.error("Failed to stop packet capture on cleanup:", cause);
        });
      }
      if (queueRunning() && props.onStopQueue !== undefined) {
        void props.onStopQueue().catch((cause: unknown) => {
          console.error("Failed to stop packet queue on cleanup:", cause);
        });
      }
    });
  });

  return (
    <Tabs
      style={{ display: "contents" }}
      value={activeTab()}
      onValueChange={(details) => setActiveTab(details.value as ActiveTab)}
    >
      <div class="standalone-window packets-window">
        <header class="standalone-window__header packets-header">
          <div class="packets-header__left">
            <TabsList class="packets-tabs__list">
              <TabsTrigger value="log">Log</TabsTrigger>
              <TabsTrigger value="send">Send</TabsTrigger>
            </TabsList>
          </div>
          <div class="standalone-window__header-actions packets-header__right">
            <Show when={activeTab() === "log"}>
              <div class="packets-header__actions">
                <Button
                  aria-label={
                    allPacketsCopied()
                      ? "Copied captured packets"
                      : "Copy all packets from enabled sources"
                  }
                  class="packets-copy-button"
                  classList={{
                    "packets-copy-button--copied": allPacketsCopied(),
                  }}
                  disabled={sourceFilteredPackets().length === 0}
                  onClick={copyAllCaptured}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <span
                    aria-hidden="true"
                    class="packets-copy-button__label-stack"
                  >
                    <span class="packets-copy-button__label packets-copy-button__label--copy">
                      Copy all
                    </span>
                    <span class="packets-copy-button__label packets-copy-button__label--copied">
                      Copied
                    </span>
                  </span>
                </Button>
                <Button
                  aria-label="Export visible packets"
                  disabled={filteredPackets().length === 0}
                  onClick={exportVisible}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <span class="packets-header__button-label">Export</span>
                </Button>
                <Button
                  aria-label={
                    captureRunning() ? "Stop capture" : "Start capture"
                  }
                  onClick={() => void toggleCapture()}
                  size="sm"
                  type="button"
                  variant={captureRunning() ? "outline" : "default"}
                >
                  <span class="packets-header__button-label">
                    {captureRunning() ? "Stop capture" : "Start capture"}
                  </span>
                </Button>
              </div>
            </Show>
            <Show when={activeTab() === "send"}>
              <div class="packets-header__actions packets-header__send-actions">
                <div class="packets-header__send-target">
                  <Label for="packet-target">Send as</Label>
                  <Select
                    class="packets-select"
                    ids={{ trigger: "packet-target" }}
                    items={sendTargetOptions}
                    value={[sendTarget()]}
                    onValueChange={(details) => {
                      const value = details.value[0];
                      if (isPacketSendTarget(value)) {
                        setSendTarget(value);
                      }
                    }}
                  >
                    <SelectTrigger size="sm">
                      <span class="select__value">
                        {sendTargetLabels[sendTarget()]}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <For each={sendTargetOptions}>
                        {(target) => (
                          <SelectItem value={target.value}>
                            {target.label}
                          </SelectItem>
                        )}
                      </For>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  aria-label={queueRunning() ? "Stop queue" : "Start queue"}
                  disabled={!queueRunning() && !canQueue()}
                  onClick={() =>
                    void (queueRunning() ? stopQueue() : startQueue())
                  }
                  size="sm"
                  type="button"
                  variant={queueRunning() ? "destructive-outline" : "default"}
                >
                  <span class="packets-header__button-label">
                    {queueRunning() ? "Stop queue" : "Start queue"}
                  </span>
                </Button>
              </div>
            </Show>
          </div>
        </header>

        <div class="standalone-window__content-frame">
          <main
            aria-label="Packet controls"
            class="standalone-window__content packets-body"
          >
            <div class="packets-shell">
              <Show when={error() !== "" || notice() !== ""}>
                <div
                  classList={{
                    "packets-message": true,
                    "packets-message--error": error() !== "",
                  }}
                >
                  <Show when={error() !== ""}>
                    <Icon
                      aria-hidden="true"
                      class="packets-message__icon"
                      icon="circle_alert"
                    />
                  </Show>
                  <span>{error() || notice()}</span>
                  <IconButton
                    aria-label="Dismiss message"
                    onClick={() => {
                      setError("");
                      setNotice("");
                    }}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <Icon icon="x" class="button__icon" />
                  </IconButton>
                </div>
              </Show>

              <div class="packets-tabs">
                <TabsContent class="packets-tabs__content" value="log">
                  <div class="packets-log-grid">
                    <div class="packets-log-tools">
                      <Input
                        ref={(element) => {
                          packetSearchInput = element;
                        }}
                        aria-label="Search packets"
                        class="packets-search"
                        placeholder="Search packets..."
                        value={search()}
                        onInput={(event) =>
                          setSearch(event.currentTarget.value)
                        }
                      />

                      <div class="packets-options-row">
                        <Checkbox
                          checked={showTimestamps()}
                          onChange={(event) =>
                            setShowTimestamps(event.currentTarget.checked)
                          }
                        >
                          Timestamps
                        </Checkbox>
                        <Checkbox
                          checked={autoScroll()}
                          onChange={(event) =>
                            setAutoScroll(event.currentTarget.checked)
                          }
                        >
                          Auto-scroll
                        </Checkbox>
                        <Checkbox
                          checked={wrapPackets()}
                          onChange={(event) =>
                            setWrapPackets(event.currentTarget.checked)
                          }
                        >
                          Wrap
                        </Checkbox>
                      </div>
                    </div>

                    <section
                      aria-label="Packet log"
                      class="packets-section packets-section--log"
                    >
                      <header class="packets-section__header">
                        <div class="packets-filter-row packets-filter-row--header">
                          <For each={PacketCaptureTypes}>
                            {(type) => (
                              <PillButton
                                aria-label={`${packetTypeLabels[type]} packets: ${stats()[type]}. ${
                                  filters()[type] ? "Shown" : "Hidden"
                                }`}
                                class={`packets-filter-button packets-filter-button--${type}`}
                                pressed={filters()[type]}
                                onClick={() => toggleFilter(type)}
                              >
                                <span class="packets-filter-button__label">
                                  {packetTypeLabels[type]}
                                </span>
                                <span
                                  aria-hidden="true"
                                  class="packets-filter-button__count"
                                >
                                  {stats()[type]}
                                </span>
                              </PillButton>
                            )}
                          </For>
                        </div>
                        <Button
                          class="packets-log-clear"
                          disabled={packets().length === 0}
                          onClick={clearPackets}
                          size="sm"
                          type="button"
                          variant="destructive-outline"
                        >
                          Clear
                        </Button>
                      </header>
                      <div class="packets-section__body">
                        <div
                          class="packets-log-list"
                          classList={{
                            "packets-log-list--wrapped": wrapPackets(),
                          }}
                          ref={logViewport}
                        >
                          <Show
                            when={filteredPackets().length > 0}
                            fallback={
                              <Empty class="packets-empty">
                                <EmptyHeader>
                                  <EmptyTitle class="packets-empty__title">
                                    {logEmptyState().title}
                                  </EmptyTitle>
                                  <Show when={logEmptyState().description}>
                                    {(description) => (
                                      <EmptyDescription class="packets-empty__description">
                                        {description()}
                                      </EmptyDescription>
                                    )}
                                  </Show>
                                </EmptyHeader>
                              </Empty>
                            }
                          >
                            <div
                              class="packets-log-virtual"
                              style={{
                                height: `${logVirtualizer.getTotalSize()}px`,
                              }}
                            >
                              <Index each={logVirtualRows()}>
                                {(row) => (
                                  <Show keyed when={row().entry}>
                                    {(entry) => (
                                      <div
                                        class="packets-log-virtual__item"
                                        ref={(element) => {
                                          // TanStack reads data-index synchronously during measurement.
                                          element.setAttribute(
                                            "data-index",
                                            String(row().item.index),
                                          );
                                          logVirtualizer.measureElement(
                                            element,
                                          );
                                        }}
                                        style={{
                                          height: `${row().item.size}px`,
                                          top: `${row().item.start}px`,
                                        }}
                                      >
                                        <PacketLogRowView entry={entry} />
                                      </div>
                                    )}
                                  </Show>
                                )}
                              </Index>
                            </div>
                          </Show>
                        </div>
                      </div>
                    </section>
                  </div>
                </TabsContent>

                <TabsContent class="packets-tabs__content" value="send">
                  <div class="packets-send-layout">
                    <div class="packets-send-grid">
                      <section
                        aria-labelledby="packets-sender-title"
                        class="packets-section packets-section--sender"
                      >
                        <header class="packets-section__header">
                          <h2
                            class="packets-section__title"
                            id="packets-sender-title"
                          >
                            <span class="packets-section__title-label">
                              Sender
                            </span>
                          </h2>
                        </header>
                        <div class="packets-section__body">
                          <form
                            class="packets-sender"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void sendPacket();
                            }}
                          >
                            <div class="packets-sender__field">
                              <PacketSenderLabelHelp />
                              <div class="packets-sender__textarea-wrapper">
                                <Textarea
                                  ref={(element) => {
                                    senderTextarea = element;
                                  }}
                                  disabled={queueRunning()}
                                  id="packet-input"
                                  onKeyDown={handleSenderKeyDown}
                                  onInput={(event) =>
                                    setSendText(event.currentTarget.value)
                                  }
                                  placeholder="Enter packet payload..."
                                  value={sendText()}
                                />
                              </div>
                            </div>

                            <div class="packets-sender__actions">
                              <Button
                                disabled={!canSend()}
                                size="sm"
                                type="submit"
                              >
                                Send once
                              </Button>
                              <Button
                                disabled={!canSend()}
                                onClick={addQueuePacket}
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                Add to queue
                              </Button>
                            </div>
                          </form>
                        </div>
                      </section>

                      <section
                        aria-labelledby="packets-queue-title"
                        class="packets-section packets-section--queue"
                      >
                        <header class="packets-section__header">
                          <h2
                            class="packets-section__title"
                            id="packets-queue-title"
                          >
                            <span class="packets-section__title-label">
                              Queue
                            </span>
                          </h2>
                        </header>
                        <div class="packets-section__body">
                          <div class="packets-queue">
                            <div class="packets-queue__toolbar">
                              <div class="packets-queue-delay">
                                <Label for="packet-queue-delay">Delay</Label>
                                <Input
                                  aria-label="Queue delay"
                                  disabled={queueRunning()}
                                  id="packet-queue-delay"
                                  max={PACKET_QUEUE_MAX_DELAY_MS}
                                  min={PACKET_QUEUE_MIN_DELAY_MS}
                                  onBlur={normalizeDelayInput}
                                  onInput={(event) =>
                                    setDelayMs(event.currentTarget.value)
                                  }
                                  step={100}
                                  type="number"
                                  value={delayMs()}
                                />
                                <span>ms</span>
                              </div>
                            </div>

                            <div
                              class="packets-queue__list"
                              classList={{
                                "packets-queue__list--populated":
                                  queue().length > 0,
                              }}
                            >
                              <Show
                                when={queue().length > 0}
                                fallback={
                                  <Empty class="packets-empty">
                                    <EmptyHeader>
                                      <EmptyTitle class="packets-empty__title">
                                        Queue is empty
                                      </EmptyTitle>
                                    </EmptyHeader>
                                  </Empty>
                                }
                              >
                                <For each={queue()}>
                                  {(packet, index) => (
                                    <Show
                                      when={editingQueueIndex() === index()}
                                      fallback={
                                        <button
                                          class="packets-queue-row"
                                          classList={{
                                            "packets-queue-row--selected":
                                              selectedQueueIndex() === index(),
                                          }}
                                          disabled={queueRunning()}
                                          onDblClick={(event) => {
                                            event.preventDefault();
                                            startQueuePacketEditAt(index());
                                          }}
                                          onClick={() =>
                                            setSelectedQueueIndex(
                                              selectedQueueIndex() === index()
                                                ? null
                                                : index(),
                                            )
                                          }
                                          type="button"
                                        >
                                          <span class="packets-queue-row__index">
                                            {String(index() + 1).padStart(
                                              2,
                                              "0",
                                            )}
                                          </span>
                                          <span class="packets-queue-row__packet">
                                            {packet}
                                          </span>
                                        </button>
                                      }
                                    >
                                      <div class="packets-queue-row packets-queue-row--editing">
                                        <span class="packets-queue-row__index">
                                          {String(index() + 1).padStart(2, "0")}
                                        </span>
                                        <div class="packets-queue-row__editor">
                                          <Textarea
                                            ref={(element) => {
                                              editingQueueTextarea = element;
                                            }}
                                            aria-label={`Edit queue packet ${
                                              index() + 1
                                            }`}
                                            disabled={queueRunning()}
                                            onInput={(event) =>
                                              setEditingQueueText(
                                                event.currentTarget.value,
                                              )
                                            }
                                            onKeyDown={handleQueueEditorKeyDown}
                                            value={editingQueueText()}
                                          />
                                          <div class="packets-queue-row__edit-actions">
                                            <TooltipIconButton
                                              aria-label="Save packet edit"
                                              disabled={queueRunning()}
                                              onClick={saveQueuePacketEdit}
                                              tooltip="Save"
                                            >
                                              <Icon
                                                icon="check"
                                                class="button__icon"
                                              />
                                            </TooltipIconButton>
                                            <TooltipIconButton
                                              aria-label="Cancel packet edit"
                                              disabled={queueRunning()}
                                              onClick={cancelQueuePacketEdit}
                                              tooltip="Cancel"
                                            >
                                              <Icon
                                                icon="x"
                                                class="button__icon"
                                              />
                                            </TooltipIconButton>
                                          </div>
                                        </div>
                                      </div>
                                    </Show>
                                  )}
                                </For>
                              </Show>
                            </div>

                            <div class="packets-queue__actions">
                              <div class="packets-queue__actions-group">
                                <TooltipIconButton
                                  aria-label="Move packet up"
                                  disabled={
                                    selectedQueueIndex() === null ||
                                    queueRunning() ||
                                    hasUnsavedQueueEdit()
                                  }
                                  onClick={() => moveQueuePacket(-1)}
                                  tooltip="Move up"
                                >
                                  <Icon icon="arrow_up" class="button__icon" />
                                </TooltipIconButton>
                                <TooltipIconButton
                                  aria-label="Move packet down"
                                  disabled={
                                    selectedQueueIndex() === null ||
                                    queueRunning() ||
                                    hasUnsavedQueueEdit()
                                  }
                                  onClick={() => moveQueuePacket(1)}
                                  tooltip="Move down"
                                >
                                  <Icon
                                    icon="arrow_down"
                                    class="button__icon"
                                  />
                                </TooltipIconButton>
                                <TooltipIconButton
                                  aria-label="Edit packet"
                                  disabled={
                                    selectedQueueIndex() === null ||
                                    queueRunning() ||
                                    editingQueueIndex() !== null
                                  }
                                  onClick={startQueuePacketEdit}
                                  tooltip="Edit"
                                >
                                  <Icon icon="pencil" class="button__icon" />
                                </TooltipIconButton>
                              </div>
                              <div class="packets-queue__actions-group">
                                <TooltipIconButton
                                  aria-label="Remove packet"
                                  disabled={
                                    selectedQueueIndex() === null ||
                                    queueRunning() ||
                                    hasUnsavedQueueEdit()
                                  }
                                  onClick={removeQueuePacket}
                                  tooltip="Remove"
                                >
                                  <Icon icon="trash_2" class="button__icon" />
                                </TooltipIconButton>
                                <Button
                                  disabled={
                                    queue().length === 0 ||
                                    queueRunning() ||
                                    hasUnsavedQueueEdit()
                                  }
                                  onClick={clearQueue}
                                  size="sm"
                                  type="button"
                                  variant="destructive-outline"
                                >
                                  Clear
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </section>
                    </div>
                  </div>
                </TabsContent>
              </div>

              <AlertDialog
                open={confirmKeyboardSendOpen()}
                onOpenChange={(details) => {
                  setConfirmKeyboardSendOpen(details.open);
                  if (!details.open) {
                    setPendingKeyboardSendPacket(null);
                  }
                }}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Send packet once?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This immediately sends the current packet as{" "}
                      {sendTargetLabels[sendTarget()]}.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={!pendingKeyboardSendPacket() || queueRunning()}
                      onClick={confirmKeyboardSend}
                      size="sm"
                    >
                      Send once
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </main>
        </div>
      </div>
    </Tabs>
  );
}

/** Connects the fixture-driven Packets view to the Electron bridge. */
export function App(): JSX.Element {
  const packets = selectDesktopBridge(window.desktop, "packets").packets;

  return (
    <PacketsView
      getStatus={() => packets.getStatus()}
      onCaptured={(listener) => packets.onCaptured(listener)}
      onCopyText={(text) => navigator.clipboard.writeText(text)}
      onSend={(payload) => packets.send(payload)}
      onStartCapture={() => packets.startCapture()}
      onStartQueue={(payload) => packets.startQueue(payload)}
      onStatus={(listener) => packets.onStatus(listener)}
      onStopCapture={() => packets.stopCapture()}
      onStopQueue={() => packets.stopQueue()}
    />
  );
}

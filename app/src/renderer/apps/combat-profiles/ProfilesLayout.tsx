/** @jsxImportSource react */
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  createMenuHandle,
  type ContextMenuProps,
  Empty,
  EmptyActions,
  EmptyMedia,
  EmptyTitle,
  Icon,
  IconButton,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from "@lucent/ui-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";

import {
  COMBAT_PROFILE_TEXT_LIMITS,
  DEFAULT_COMBAT_PROFILE_ID,
  type CombatProfile,
} from "@lucent/core/combatProfiles";
import {
  buildCombatProfileOptions,
  type ProfileSummary,
} from "../../combatProfileOptions";
import {
  readLocalStorageValue,
  writeLocalStorageValue,
} from "../../localStorage";
import { ClassTagsField } from "./controls";
import { hasIncompleteRows } from "./profileModel";
import type { ProfileEditor } from "./useProfileEditor";

const matchesQuery = (profile: ProfileSummary, query: string): boolean => {
  const needle = query.trim().toLocaleLowerCase();
  return (
    needle === "" ||
    [profile.label, ...(profile.classNames ?? [])].some((text) =>
      text.toLocaleLowerCase().includes(needle),
    )
  );
};

const withClassNames = (
  profile: CombatProfile,
  classNames: readonly string[],
): CombatProfile => {
  const { classNames: _classNames, ...rest } = profile;
  return classNames.length === 0 ? rest : { ...rest, classNames };
};

const COMPACT_QUERY = "(max-width: 639px)";

const subscribeCompact = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

const isCompact = (): boolean => window.matchMedia(COMPACT_QUERY).matches;

type ProfileRef = Pick<CombatProfile, "id" | "label">;

export function ProfilesLayout({
  children,
  editor,
}: {
  readonly children: (draft: CombatProfile) => ReactNode;
  readonly editor: ProfileEditor;
}) {
  const compact = useSyncExternalStore(subscribeCompact, isCompact);
  const detail = useRef<HTMLDivElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProfileRef>({
    id: "",
    label: "",
  });
  const draftId = editor.draft?.id;
  const dialogOpen = deleting || editor.leaving;
  const requestDelete = (profile: ProfileRef) => {
    setDeleteTarget({ id: profile.id, label: profile.label });
    setDeleting(true);
  };

  useHotkey(
    "Mod+N",
    (event) => {
      if (!event.repeat) {
        editor.create();
      }
    },
    { enabled: editor.loaded && !dialogOpen },
  );

  useHotkey(
    "Mod+S",
    (event) => {
      if (!event.repeat) {
        void editor.save();
      }
    },
    { enabled: editor.loaded && !dialogOpen },
  );

  useEffect(() => {
    detail.current?.scrollTo({ top: 0 });
  }, [draftId]);

  if (editor.loadFailed) {
    return <LoadFailedState onRetry={editor.reload} />;
  }

  return (
    <div className="cp-library" data-compact={compact ? "" : undefined}>
      {compact ? null : (
        <aside aria-label="Profiles" className="cp-library-sidebar">
          <ProfileBrowser
            dialogOpen={dialogOpen}
            editor={editor}
            onDelete={requestDelete}
            variant="sidebar"
          />
        </aside>
      )}
      <main className="cp-library-detail">
        {editor.draft === undefined ? null : (
          <div className="cp-library-bar">
            <ProfileHeader
              compact={compact}
              dialogOpen={dialogOpen}
              draft={editor.draft}
              editor={editor}
              onDelete={requestDelete}
            />
          </div>
        )}
        <div className="cp-library-body" ref={detail}>
          <div aria-hidden className="cp-library-scrolled" />
          {editor.loaded ? null : <LoadingState />}
          {editor.draft === undefined ? null : (
            <div className="cp-library-sheet">
              <ProfileClasses draft={editor.draft} editor={editor} />
              <Fragment key={editor.draft.id}>
                {children(editor.draft)}
              </Fragment>
              {editor.dirty ? <SaveBar editor={editor} /> : null}
            </div>
          )}
        </div>
      </main>
      {editor.draft === undefined ? null : (
        <>
          <UnsavedChangesDialog editor={editor} label={editor.draft.label} />
          <DeleteProfileDialog
            editor={editor}
            onOpenChange={setDeleting}
            open={deleting}
            profile={deleteTarget}
          />
        </>
      )}
    </div>
  );
}

const LOADING_HINT_DELAY_MS = 300;

function LoadingState() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setVisible(true),
      LOADING_HINT_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  return visible ? (
    <p aria-live="polite" className="cp-library-loading">
      <Spinner size={14} />
      Loading profiles…
    </p>
  ) : null;
}

function LoadFailedState({
  onRetry,
}: {
  readonly onRetry: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);

  const retry = () => {
    setRetrying(true);
    void onRetry().finally(() => setRetrying(false));
  };

  return (
    <Empty className="cp-library-load-failed">
      <EmptyMedia>
        <Icon icon="circle_alert" size="md" />
      </EmptyMedia>
      <EmptyTitle>Couldn't load your profiles</EmptyTitle>
      <EmptyActions>
        <Button loading={retrying} onClick={retry} size="sm">
          Try again
        </Button>
      </EmptyActions>
    </Empty>
  );
}

const GROUP_STORAGE_KEY = "lucent.combatProfiles.groupByClass";
const JUMP_INSET_PX = 8;
const LIST_PADDING_START_PX = 4;
const LIST_PADDING_END_PX = 8;

interface BrowserEntry {
  readonly classNames: readonly string[];
  readonly group: string | undefined;
  readonly id: string;
  readonly label: string;
  readonly pinned: boolean;
  readonly value: string;
}

type BrowserRow =
  | { readonly kind: "header"; readonly label: string }
  | {
      readonly kind: "option";
      readonly entry: BrowserEntry;
      readonly index: number;
    };

interface StickyLabel {
  readonly label: string;
  readonly shift: number;
}

interface RowHeights {
  readonly compact: number;
  readonly header: number;
  readonly label: number;
  readonly option: number;
}

const INITIAL_ROW_HEIGHTS: RowHeights = {
  compact: 33,
  header: 30,
  label: 28,
  option: 53,
};

const stickyLabelAt = (
  offset: number,
  measurements: readonly VirtualItem[],
  rows: readonly BrowserRow[],
  labelHeight: number,
): StickyLabel | undefined => {
  if (offset <= 0) {
    return undefined;
  }

  let label: string | undefined;
  for (const item of measurements) {
    if (item.start >= offset + labelHeight) {
      break;
    }
    const row = rows[item.index];
    if (row?.kind !== "header") {
      continue;
    }
    if (item.start > offset) {
      return label === undefined
        ? undefined
        : { label, shift: item.start - offset - labelHeight };
    }
    label = row.label;
  }
  return label === undefined ? undefined : { label, shift: 0 };
};

/** Every row of a kind shares one height, so one hidden sample per kind sizes the whole list. */
function useRowHeights(probe: RefObject<HTMLDivElement | null>): RowHeights {
  const [heights, setHeights] = useState(INITIAL_ROW_HEIGHTS);

  useLayoutEffect(() => {
    const element = probe.current;
    if (element === null) {
      return undefined;
    }
    const heightOf = (selector: string) =>
      element.querySelector(selector)?.getBoundingClientRect().height ?? 0;
    const read = () => {
      const next: RowHeights = {
        compact: heightOf('[data-probe="compact"]'),
        header: heightOf('[data-probe="header"]'),
        label: heightOf('[data-probe="header"] > *'),
        option: heightOf('[data-probe="option"]'),
      };
      setHeights((current) =>
        current.compact === next.compact &&
        current.header === next.header &&
        current.label === next.label &&
        current.option === next.option
          ? current
          : next,
      );
    };
    read();
    const observer = new ResizeObserver(read);
    for (const row of element.children) {
      observer.observe(row);
    }
    return () => observer.disconnect();
  }, [probe]);

  return heights;
}

function useScrollbarWidth(scroller: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) {
      return undefined;
    }
    const read = () => setWidth(element.offsetWidth - element.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller]);

  return width;
}

function RowHeightProbe({
  ref,
}: {
  readonly ref: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div aria-hidden className="cp-library-probe" ref={ref}>
      <div className="cp-library-row" data-probe="header">
        <div className="cp-library-section__label">Class</div>
      </div>
      <div className="cp-library-row" data-probe="option">
        <div className="cp-library-item">
          <div className="cp-library-item__head">
            <span className="cp-library-item__name">Profile</span>
          </div>
          <span className="cp-library-item__classes">Any class</span>
        </div>
      </div>
      <div className="cp-library-row" data-probe="compact">
        <div className="cp-library-item" data-compact="">
          <div className="cp-library-item__head">
            <span className="cp-library-item__name">Profile</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Tracks scrollTop itself because the virtualizer only re-renders when its visible range changes. */
function StickyGroupLabel({
  labelHeight,
  measurements,
  rows,
  scroller,
}: {
  readonly labelHeight: number;
  readonly measurements: readonly VirtualItem[];
  readonly rows: readonly BrowserRow[];
  readonly scroller: RefObject<HTMLDivElement | null>;
}) {
  const subscribe = useCallback(
    (onScroll: () => void) => {
      const element = scroller.current;
      element?.addEventListener("scroll", onScroll, { passive: true });
      return () => element?.removeEventListener("scroll", onScroll);
    },
    [scroller],
  );
  const offset = useSyncExternalStore(
    subscribe,
    () => scroller.current?.scrollTop ?? 0,
  );
  const sticky = stickyLabelAt(offset, measurements, rows, labelHeight);

  return sticky === undefined ? null : (
    <div
      aria-hidden
      className="cp-library-section__label"
      data-sticky=""
      style={{
        height: labelHeight,
        marginBottom: -(labelHeight + LIST_PADDING_START_PX),
        marginTop: LIST_PADDING_START_PX,
        transform:
          sticky.shift === 0 ? undefined : `translateY(${sticky.shift}px)`,
      }}
    >
      {sticky.label}
    </div>
  );
}

function ProfileBrowser({
  dialogOpen = false,
  editor,
  onDelete,
  onPicked,
  variant,
}: {
  readonly dialogOpen?: boolean;
  readonly editor: ProfileEditor;
  readonly onDelete?: (profile: ProfileRef) => void;
  readonly onPicked?: () => void;
  readonly variant: "sidebar" | "popover";
}) {
  const menuAction = useRef<(() => void) | undefined>(undefined);
  const [actionsMenu] = useState(() => createMenuHandle<BrowserEntry>());
  const contextMenu =
    useRef<NonNullable<ContextMenuProps["actionsRef"]>["current"]>(null);
  const [contextProfile, setContextProfile] = useState<ProfileRef | undefined>(
    undefined,
  );
  const [contextRow, setContextRow] = useState<string | undefined>(undefined);
  const closeContextMenu = useCallback(() => contextMenu.current?.close(), []);
  const closeActionsMenu = useCallback(
    () => actionsMenu.close(),
    [actionsMenu],
  );
  const [query, setQuery] = useState("");
  const [grouped, setGrouped] = useState(
    () => readLocalStorageValue(GROUP_STORAGE_KEY) === "true",
  );
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const rowHeights = useRowHeights(probe);
  const scrollbarWidth = useScrollbarWidth(scroller);
  const listId = useId();

  const entries = useMemo((): readonly BrowserEntry[] => {
    const generic = editor.profiles.find(
      (profile) => profile.id === DEFAULT_COMBAT_PROFILE_ID,
    );
    const pinned: BrowserEntry[] =
      generic === undefined || !matchesQuery(generic, query)
        ? []
        : [
            {
              classNames: generic.classNames ?? [],
              group: undefined,
              id: generic.id,
              label: generic.label,
              pinned: true,
              value: generic.id,
            },
          ];
    const others = editor.profiles.filter(
      (profile) =>
        profile.id !== DEFAULT_COMBAT_PROFILE_ID &&
        matchesQuery(profile, query),
    );
    return [
      ...pinned,
      ...buildCombatProfileOptions(others, grouped).map((option) => ({
        classNames: option.classNames,
        group: option.group,
        id: option.id,
        label: option.label,
        pinned: false,
        value: option.value,
      })),
    ];
  }, [editor.profiles, grouped, query]);

  const { rowIndexOf, rows } = useMemo(() => {
    const built: BrowserRow[] = [];
    const indexOf = new Map<number, number>();
    let group: string | undefined;
    entries.forEach((entry, index) => {
      if (entry.pinned) {
        return;
      }
      if (entry.group !== undefined && entry.group !== group) {
        group = entry.group;
        built.push({ kind: "header", label: entry.group });
      }
      indexOf.set(index, built.length);
      built.push({ kind: "option", entry, index });
    });
    return { rowIndexOf: indexOf, rows: built };
  }, [entries]);

  const optionRowHeight = grouped ? rowHeights.compact : rowHeights.option;
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: (index) =>
      rows[index]?.kind === "header" ? rowHeights.header : optionRowHeight,
    getScrollElement: () => scroller.current,
    overscan: 8,
    paddingEnd: LIST_PADDING_END_PX,
    paddingStart: LIST_PADDING_START_PX,
    scrollPaddingEnd: LIST_PADDING_END_PX,
    scrollPaddingStart:
      (grouped ? rowHeights.label : 0) + LIST_PADDING_START_PX,
  });

  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowHeights, rows, virtualizer]);

  const exactIndex = entries.findIndex(
    (entry) => entry.id === editor.selectedId && entry.value === activeValue,
  );
  const activeIndex = Math.max(
    0,
    exactIndex === -1
      ? entries.findIndex((entry) => entry.id === editor.selectedId)
      : exactIndex,
  );
  const optionId = (index: number) => `${listId}-option-${index}`;

  useHotkey(
    "/",
    (event) => {
      if (!event.repeat) {
        search.current?.focus();
        search.current?.select();
      }
    },
    {
      conflictBehavior: "allow",
      enabled: variant === "sidebar" && !dialogOpen,
    },
  );

  const activeRow = rowIndexOf.get(activeIndex);
  useEffect(() => {
    if (activeRow !== undefined) {
      virtualizer.scrollToIndex(activeRow, { align: "auto" });
    }
  }, [activeRow, virtualizer]);

  const runMenuAction = (open: boolean) => {
    const action = menuAction.current;
    menuAction.current = undefined;
    if (!open && action !== undefined) {
      // Base UI refocuses the list in a microtask after the menu unmounts.
      window.setTimeout(action);
    }
  };

  const actionsFor = (profile: ProfileRef, close: () => void) =>
    onDelete === undefined ? null : (
      <ProfileActions
        close={close}
        editor={editor}
        onChoose={(action) => (menuAction.current = action)}
        onDelete={onDelete}
        profile={profile}
      />
    );

  const pick = (entry: BrowserEntry) => {
    setActiveValue(entry.value);
    editor.select(entry.id);
  };

  const move = (index: number) => {
    const entry = entries[index];
    if (entry !== undefined) {
      pick(entry);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      move(activeIndex);
      onPicked?.();
      return;
    }
    const last = entries.length - 1;
    const pageSize = Math.max(
      1,
      Math.floor((scroller.current?.clientHeight ?? 0) / optionRowHeight),
    );
    const next =
      event.key === "ArrowDown"
        ? Math.min(last, activeIndex + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, activeIndex - 1)
          : event.key === "PageDown"
            ? Math.min(last, activeIndex + pageSize)
            : event.key === "PageUp"
              ? Math.max(0, activeIndex - pageSize)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? last
                  : undefined;
    if (next !== undefined) {
      event.preventDefault();
      move(next);
    }
  };

  const renderOption = (entry: BrowserEntry, index: number) => (
    <div
      aria-label={
        grouped && !entry.pinned && entry.group !== undefined
          ? `${entry.label}, ${entry.group}`
          : undefined
      }
      aria-selected={entry.id === editor.selectedId && index === activeIndex}
      data-selected={entry.id === editor.selectedId ? "" : undefined}
      className="cp-library-item"
      data-active={index === activeIndex ? "" : undefined}
      data-compact={grouped && !entry.pinned ? "" : undefined}
      data-menu-target={entry.value === contextRow ? "" : undefined}
      id={optionId(index)}
      onClick={() => {
        pick(entry);
        onPicked?.();
      }}
      onContextMenu={() => {
        setContextProfile(entry);
        setContextRow(entry.value);
      }}
      role="option"
    >
      <div className="cp-library-item__head">
        <span className="cp-library-item__name">{entry.label}</span>
        {onDelete === undefined ? null : (
          <MenuTrigger
            handle={actionsMenu}
            onClick={(event) => event.stopPropagation()}
            payload={entry}
            render={
              <IconButton
                aria-hidden
                className="cp-library-item__more"
                label="More actions"
                size="sm"
                tabIndex={-1}
                tooltip={false}
              >
                <Icon icon="ellipsis" size="md" />
              </IconButton>
            }
          />
        )}
      </div>
      {grouped && !entry.pinned ? null : (
        <span
          className="cp-library-item__classes"
          data-empty={entry.classNames.length === 0 ? "" : undefined}
        >
          {entry.classNames.length === 0
            ? "Any class"
            : entry.classNames.join(", ")}
        </span>
      )}
    </div>
  );

  const pinned = entries[0]?.pinned === true ? entries[0] : undefined;
  const virtualRows = virtualizer.getVirtualItems();
  const renderedTop = virtualRows[0]?.start ?? 0;
  const renderedHeight = (virtualRows.at(-1)?.end ?? 0) - renderedTop;
  const offset = virtualizer.scrollOffset ?? 0;
  const selectedRow =
    entries[activeIndex]?.id === editor.selectedId
      ? rowIndexOf.get(activeIndex)
      : undefined;
  const selectedItem =
    selectedRow === undefined
      ? undefined
      : virtualizer.measurementsCache[selectedRow];
  const sticky = grouped
    ? stickyLabelAt(
        offset,
        virtualizer.measurementsCache,
        rows,
        rowHeights.label,
      )
    : undefined;
  const stickyHeight =
    sticky === undefined ? 0 : rowHeights.label + sticky.shift;
  const viewportHeight = virtualizer.scrollRect?.height ?? 0;
  // The browser can scroll past the rendered rows before React renders the new range.
  // These sticky insets pin the rows to that viewport edge instead of exposing blank space.
  // TanStack rounds the viewport height, so it can exceed the real one by half a pixel.
  const renderedOverflow = viewportHeight - 0.5 - renderedHeight;
  const renderedInsets = {
    bottom: Math.min(0, renderedOverflow - LIST_PADDING_START_PX),
    top: Math.min(0, renderedOverflow - LIST_PADDING_END_PX),
  };
  const hiddenSelection =
    selectedItem === undefined || viewportHeight === 0
      ? undefined
      : selectedItem.end <= offset + stickyHeight
        ? "up"
        : selectedItem.start >= offset + viewportHeight
          ? "down"
          : undefined;
  const jumpButton = (direction: "up" | "down") => (
    <div
      className="cp-library-jump"
      data-edge={direction === "up" ? "top" : "bottom"}
      style={
        direction === "up"
          ? { top: (grouped ? rowHeights.label : 0) + JUMP_INSET_PX }
          : { bottom: JUMP_INSET_PX }
      }
    >
      <IconButton
        label="Scroll to selected profile"
        onClick={() => {
          if (selectedRow !== undefined) {
            virtualizer.scrollToIndex(selectedRow, { align: "center" });
          }
        }}
        onMouseDown={(event) => event.preventDefault()}
        size="sm"
        tabIndex={-1}
        variant="secondary"
      >
        <Icon icon={direction === "up" ? "arrow_up" : "arrow_down"} size="sm" />
      </IconButton>
    </div>
  );

  return (
    <div className="cp-library-browser" data-variant={variant}>
      <div className="cp-library-search">
        <InputGroup size="sm">
          <InputGroupAddon>
            <Icon icon="search" size="sm" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search profiles"
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return;
              }
              if (event.key === "ArrowDown" || event.key === "Enter") {
                event.preventDefault();
                move(activeIndex);
                list.current?.focus();
              } else if (event.key === "Escape" && query !== "") {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
            onValueChange={setQuery}
            placeholder="Search"
            ref={search}
            spellCheck={false}
            type="search"
            value={query}
          />
          {query === "" ? null : (
            <InputGroupAddon>
              <IconButton
                className="cp-library-search__clear"
                label="Clear search"
                onClick={() => setQuery("")}
                onMouseDown={(event) => event.preventDefault()}
                size="sm"
                tabIndex={-1}
              >
                <Icon icon="x" size="sm" />
              </IconButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <IconButton
          aria-pressed={grouped}
          className="cp-library-group-toggle"
          label="Group by class"
          onClick={() => {
            writeLocalStorageValue(GROUP_STORAGE_KEY, String(!grouped));
            setGrouped(!grouped);
          }}
          size="sm"
        >
          <Icon icon="list_tree" size="md" />
        </IconButton>
      </div>
      <ContextMenu
        actionsRef={contextMenu}
        disabled={onDelete === undefined}
        onOpenChange={(open) => {
          if (!open) {
            setContextRow(undefined);
          }
        }}
        onOpenChangeComplete={runMenuAction}
      >
        <ContextMenuTrigger
          aria-activedescendant={
            entries[activeIndex]?.pinned === true ||
            virtualRows.some((item) => item.index === activeRow)
              ? optionId(activeIndex)
              : undefined
          }
          aria-label="Profiles"
          className="cp-library-list"
          onContextMenu={(event) => {
            const onOption =
              event.target instanceof Element &&
              event.target.closest('[role="option"]') !== null;
            const selected =
              event.target === event.currentTarget
                ? editor.profiles.find(
                    (profile) => profile.id === editor.selectedId,
                  )
                : undefined;
            if (!onOption && selected === undefined) {
              event.preventBaseUIHandler();
            } else if (selected !== undefined) {
              setContextProfile(selected);
            }
          }}
          onFocus={(event) => {
            if (
              event.target === event.currentTarget &&
              activeRow !== undefined
            ) {
              virtualizer.scrollToIndex(activeRow, { align: "auto" });
            }
          }}
          onKeyDown={onListKeyDown}
          ref={list}
          role="listbox"
          style={
            {
              "--cp-library-scrollbar-width": `${scrollbarWidth}px`,
            } as CSSProperties
          }
          tabIndex={0}
        >
          {pinned === undefined ? null : (
            <div className="cp-library-pinned">
              {renderOption(pinned, 0)}
              {rows.length > 0 ? (
                <div aria-hidden className="cp-library-pin-divider" />
              ) : null}
            </div>
          )}
          <div
            className="cp-library-scroll"
            onFocus={(event) => {
              if (event.target === event.currentTarget) {
                list.current?.focus({ preventScroll: true });
              }
            }}
            ref={scroller}
            tabIndex={-1}
          >
            {grouped ? (
              <StickyGroupLabel
                labelHeight={rowHeights.label}
                measurements={virtualizer.measurementsCache}
                rows={rows}
                scroller={scroller}
              />
            ) : null}
            {hiddenSelection === "up" ? jumpButton("up") : null}
            <div
              className="cp-library-rows"
              style={{ height: virtualizer.getTotalSize() }}
            >
              <RowHeightProbe ref={probe} />
              <div style={{ height: renderedTop }} />
              <div className="cp-library-rendered" style={renderedInsets}>
                {virtualRows.map((item) => {
                  const row = rows[item.index];
                  return row === undefined ? null : (
                    <div
                      className="cp-library-row"
                      key={item.key}
                      style={{ height: item.size }}
                    >
                      {row.kind === "header" ? (
                        <div aria-hidden className="cp-library-section__label">
                          {row.label}
                        </div>
                      ) : (
                        renderOption(row.entry, row.index)
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            {hiddenSelection === "down" ? jumpButton("down") : null}
            {entries.length === 0 && query.trim() !== "" ? (
              <p className="cp-library-noresults">
                No profiles match "{query.trim()}"
              </p>
            ) : null}
          </div>
        </ContextMenuTrigger>
        {onDelete === undefined ? null : (
          <ContextMenuContent>
            {contextProfile === undefined
              ? null
              : actionsFor(contextProfile, closeContextMenu)}
          </ContextMenuContent>
        )}
      </ContextMenu>
      <div className="cp-library-footer">
        <button
          className="cp-library-new"
          disabled={!editor.loaded || editor.creating}
          onClick={() => {
            setQuery("");
            editor.create();
            onPicked?.();
          }}
          type="button"
        >
          <Icon icon="plus" size="md" />
          <span className="cp-library-new__label">New profile</span>
        </button>
      </div>
      {onDelete === undefined ? null : (
        <Menu handle={actionsMenu} onOpenChangeComplete={runMenuAction}>
          {({ payload }) => (
            <MenuContent align="end" finalFocus={list}>
              {payload === undefined
                ? null
                : actionsFor(payload, closeActionsMenu)}
            </MenuContent>
          )}
        </Menu>
      )}
    </div>
  );
}

function ProfileActions({
  close,
  editor,
  onChoose,
  onDelete,
  profile,
}: {
  readonly close: () => void;
  readonly editor: ProfileEditor;
  readonly onChoose: (action: () => void) => void;
  readonly onDelete: (profile: ProfileRef) => void;
  readonly profile: ProfileRef;
}) {
  const exists = editor.profiles.some(
    (candidate) => candidate.id === profile.id,
  );
  const isDefault = profile.id === DEFAULT_COMBAT_PROFILE_ID;

  useEffect(() => {
    if (!exists) {
      close();
    }
  }, [close, exists]);

  return (
    <>
      <MenuItem onClick={() => onChoose(() => editor.rename(profile.id))}>
        <Icon icon="pencil" size="md" />
        Rename
      </MenuItem>
      <MenuItem onClick={() => onChoose(() => editor.duplicate(profile.id))}>
        <Icon icon="files" size="md" />
        Duplicate
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        disabled={isDefault}
        onClick={() => onChoose(() => onDelete(profile))}
        variant={isDefault ? "default" : "danger"}
      >
        <Icon icon="trash_2" size="md" />
        Delete profile
      </MenuItem>
    </>
  );
}

function ProfileSwitcher({
  dialogOpen,
  editor,
}: {
  readonly dialogOpen: boolean;
  readonly editor: ProfileEditor;
}) {
  const [open, setOpen] = useState(false);

  useHotkey(
    "/",
    (event) => {
      if (!event.repeat) {
        setOpen(true);
      }
    },
    { conflictBehavior: "allow", enabled: !dialogOpen },
  );

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <IconButton
            className="cp-library-switcher"
            label="Profiles"
            size="sm"
            tooltip={false}
            variant="secondary"
          >
            <Icon icon="chevrons_up_down" size="md" />
          </IconButton>
        }
      />
      <PopoverContent
        align="start"
        aria-label="Profiles"
        className="cp-library-switcher__popup"
      >
        <ProfileBrowser
          editor={editor}
          onPicked={() => setOpen(false)}
          variant="popover"
        />
      </PopoverContent>
    </Popover>
  );
}

const COPY_FEEDBACK_MS = 2_000;

type CopyState = "idle" | "copied" | "failed";

function CopySnippetButton({
  compact,
  editor,
}: {
  readonly compact: boolean;
  readonly editor: ProfileEditor;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const show = (next: CopyState) => {
    setState(next);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(
      () => setState("idle"),
      COPY_FEEDBACK_MS,
    );
  };

  const copy = () => {
    editor.copySnippet().then(
      (copied) => {
        if (copied) {
          show("copied");
        }
      },
      () => show("failed"),
    );
  };

  const icon = (
    <Icon
      icon={
        state === "copied"
          ? "check"
          : state === "failed"
            ? "circle_alert"
            : "braces"
      }
      size="md"
    />
  );

  return (
    <>
      {compact ? (
        <IconButton
          className="cp-library-copy"
          data-state={state}
          label={
            state === "copied"
              ? "Copied"
              : state === "failed"
                ? "Couldn't copy"
                : "Copy for scripts"
          }
          onClick={copy}
          size="sm"
        >
          {icon}
        </IconButton>
      ) : (
        <Button
          className="cp-library-copy"
          data-state={state}
          onClick={copy}
          size="sm"
          variant="ghost"
        >
          {icon}
          Copy for scripts
        </Button>
      )}
      <span aria-atomic="true" className="cp-library-sr" role="status">
        {state === "copied"
          ? "Copied profile for scripts."
          : state === "failed"
            ? "Couldn't copy the profile."
            : ""}
      </span>
    </>
  );
}

function DeleteProfileDialog({
  editor,
  onOpenChange,
  open,
  profile,
}: {
  readonly editor: ProfileEditor;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly profile: ProfileRef;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = () => {
    setPending(true);
    setFailed(false);
    editor
      .remove(profile.id)
      .then(
        () => onOpenChange(false),
        () => setFailed(true),
      )
      .finally(() => setPending(false));
  };

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!pending) {
          onOpenChange(next);
        }
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) {
          setFailed(false);
        }
      }}
      open={open}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete profile</AlertDialogTitle>
          <AlertDialogDescription className="cp-library-dialog-text">
            Delete "{profile.label}"? This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed ? (
          <AlertDialogBody>
            <Alert role="alert" variant="danger">
              <AlertDescription>
                Couldn't delete the profile. Try again.
              </AlertDescription>
            </Alert>
          </AlertDialogBody>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={pending}
            render={<Button size="sm" type="button" />}
          >
            Cancel
          </AlertDialogClose>
          <Button
            loading={pending}
            onClick={confirm}
            size="sm"
            type="button"
            variant="danger"
          >
            Delete profile
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SaveBar({ editor }: { readonly editor: ProfileEditor }) {
  const bar = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = bar.current;
    return () => {
      if (element?.contains(document.activeElement)) {
        const title = element
          .closest(".cp-library-detail")
          ?.querySelector<HTMLElement>(".cp-library-title__button");
        window.setTimeout(() => title?.focus());
      }
    };
  }, []);

  const blocked =
    editor.invalidRequest > 0 &&
    editor.draft !== undefined &&
    hasIncompleteRows(editor.draft);
  const saveError =
    blocked || editor.saveError === undefined
      ? undefined
      : `Couldn't save: ${editor.saveError}`;
  return (
    <div
      aria-label="Unsaved changes"
      className="cp-savebar"
      ref={bar}
      role="group"
    >
      <span
        aria-live="polite"
        className="cp-savebar__text"
        data-error={blocked || saveError !== undefined ? "" : undefined}
        title={saveError}
      >
        {blocked
          ? "Fill in the highlighted fields"
          : (saveError ?? "Unsaved changes")}
      </span>
      <Button
        disabled={editor.saving}
        onClick={editor.revert}
        size="sm"
        variant="ghost"
      >
        Revert
      </Button>
      <Button
        loading={editor.saving}
        onClick={() => void editor.save()}
        size="sm"
        variant="primary"
      >
        Save
      </Button>
    </div>
  );
}

function UnsavedChangesDialog({
  editor,
  label,
}: {
  readonly editor: ProfileEditor;
  readonly label: string;
}) {
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          editor.resolveLeave("cancel");
        }
      }}
      open={editor.leaving}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes?</AlertDialogTitle>
          <AlertDialogDescription className="cp-library-dialog-text">
            "{label}" has unsaved changes. Discarding them can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button size="sm" type="button" />}>
            Keep editing
          </AlertDialogClose>
          <Button
            onClick={() => editor.resolveLeave("discard")}
            size="sm"
            type="button"
            variant="danger"
          >
            Discard changes
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ProfileHeader({
  compact,
  dialogOpen,
  draft,
  editor,
  onDelete,
}: {
  readonly compact: boolean;
  readonly dialogOpen: boolean;
  readonly draft: CombatProfile;
  readonly editor: ProfileEditor;
  readonly onDelete: (profile: ProfileRef) => void;
}) {
  const [moreMenu] = useState(() => createMenuHandle());
  const closeMoreMenu = useCallback(() => moreMenu.close(), [moreMenu]);
  const menuAction = useRef<(() => void) | undefined>(undefined);

  return (
    <header className="cp-library-header">
      {compact ? (
        <ProfileSwitcher dialogOpen={dialogOpen} editor={editor} />
      ) : null}
      <ProfileName draft={draft} editor={editor} key={draft.id} />
      <div className="cp-library-actions">
        <CopySnippetButton compact={compact} editor={editor} key={draft.id} />
        <Menu
          handle={moreMenu}
          onOpenChangeComplete={(open) => {
            const action = menuAction.current;
            menuAction.current = undefined;
            if (!open && action !== undefined) {
              window.setTimeout(action);
            }
          }}
        >
          <MenuTrigger
            handle={moreMenu}
            render={
              <IconButton label="More actions" size="sm">
                <Icon icon="ellipsis" size="md" />
              </IconButton>
            }
          />
          <MenuContent align="end">
            <ProfileActions
              close={closeMoreMenu}
              editor={editor}
              onChoose={(action) => (menuAction.current = action)}
              onDelete={onDelete}
              profile={draft}
            />
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}

function ProfileClasses({
  draft,
  editor,
}: {
  readonly draft: CombatProfile;
  readonly editor: ProfileEditor;
}) {
  const labelId = useId();
  return (
    <div className="cp-library-classes">
      <span className="cp-library-sr" id={labelId}>
        Classes
      </span>
      <ClassTagsField
        aria-labelledby={labelId}
        classNames={draft.classNames ?? []}
        editing={editor.classNameEdit}
        inputValue={editor.pendingClassName}
        key={draft.id}
        onChange={(classNames) =>
          editor.update((current) => withClassNames(current, classNames))
        }
        onEditingChange={editor.setClassNameEdit}
        onFinishEditing={editor.finishClassNameEdit}
        onInputValueChange={editor.setPendingClassName}
      />
    </div>
  );
}

function ProfileName({
  draft,
  editor,
}: {
  readonly draft: CombatProfile;
  readonly editor: ProfileEditor;
}) {
  const [renaming, setRenaming] = useState(false);
  const original = useRef(draft.label);
  const latestLabel = useRef(draft.label);
  const cancelRename = useRef(false);
  const refocusTitle = useRef(false);
  const name = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLButtonElement>(null);
  latestLabel.current = draft.label;

  const startRenaming = () => {
    original.current = draft.label;
    setRenaming(true);
  };

  useEffect(() => {
    if (editor.focusNameRequest > 0) {
      original.current = latestLabel.current;
      setRenaming(true);
    }
  }, [editor.focusNameRequest]);

  useEffect(() => {
    if (renaming) {
      name.current?.focus();
      name.current?.select();
    } else if (refocusTitle.current) {
      refocusTitle.current = false;
      title.current?.focus();
    }
  }, [renaming]);

  const finishWithKeyboard = () => {
    refocusTitle.current = true;
    name.current?.blur();
  };

  return renaming ? (
    <input
      aria-label="Profile name"
      autoComplete="off"
      className="cp-library-title"
      data-editing=""
      maxLength={COMBAT_PROFILE_TEXT_LIMITS.label}
      onBlur={(event) => {
        if (cancelRename.current || event.currentTarget.value.trim() === "") {
          const label = original.current;
          editor.update((current) => ({ ...current, label }));
        }
        cancelRename.current = false;
        setRenaming(false);
      }}
      onChange={(event) => {
        const label = event.currentTarget.value;
        editor.update((current) => ({ ...current, label }));
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancelRename.current = true;
        }
        if (
          event.key === "Enter" ||
          event.key === "Escape" ||
          ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s")
        ) {
          finishWithKeyboard();
        }
      }}
      ref={name}
      spellCheck={false}
      value={draft.label}
    />
  ) : (
    <h1 className="cp-library-title">
      <button
        className="cp-library-title__button"
        onClick={startRenaming}
        ref={title}
        type="button"
      >
        {draft.label}
      </button>
    </h1>
  );
}

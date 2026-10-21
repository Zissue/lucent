/** @jsxImportSource react */
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Empty,
  EmptyDescription,
  EmptyTitle,
  Icon,
  IconButton,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  Spinner,
  toast,
} from "@lucent/ui-react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import type { LoaderGrabberLoadRequest } from "../../../shared/loader-grabber";
import { downloadJson } from "../../lib/download";
import {
  readLocalStorageValue,
  writeLocalStorageValue,
} from "../../localStorage";
import {
  NO_FILTERS,
  OPEN_TARGETS,
  SOURCES,
  SOURCE_ORDER,
  activeFilterCount,
  describeOpenRequest,
  exportFileName,
  filterGroups,
  formatNumber,
  parseIdInput,
  type Column,
  type Criteria,
  type Entry,
  type FilterGroup,
  type Filters,
  type OpenTarget,
  type OpenTargetInfo,
  type Source,
} from "./model";
import {
  Badges,
  Delayed,
  EntryDetail,
  EntryMenuItems,
  HeadingId,
  Highlight,
  SourceEmpty,
  TagText,
  viewOf,
} from "./shared";
import { lastSnapshot, type LoaderGrabber } from "./useLoaderGrabber";

const COLUMN_MAX_CH = 16;
const INITIAL_ROW_HEIGHT_PX = 30;
const INSPECTOR_WIDTH_STORAGE_KEY = "lucent.loader-grabber.inspector-width";
const INSPECTOR_DEFAULT_PX = 288;
const INSPECTOR_MIN_REM = 14;
const TABLE_MIN_REM = 16;
const SPLITTER_STEP_PX = 16;
const LIST_OVERSCAN = 12;

const gridColumns = (
  columns: readonly Column[],
  entries: readonly Entry[],
): CSSProperties & Record<"--lg-columns", string> => ({
  "--lg-columns": [
    "minmax(8rem, 1fr)",
    ...columns.map((column, index) => {
      const longest = entries.reduce(
        (max, entry) => Math.max(max, entry.cells[index]?.length ?? 0),
        column.label.length,
      );
      return `${Math.min(longest, COLUMN_MAX_CH) + 1}ch`;
    }),
  ].join(" "),
});

const inspectorStyle = (
  width: number,
): CSSProperties & Record<"--lg-inspector-width", string> => ({
  "--lg-inspector-width": `${width}px`,
});

function useRowHeight(probe: RefObject<HTMLDivElement | null>): number {
  const [height, setHeight] = useState(INITIAL_ROW_HEIGHT_PX);
  useLayoutEffect(() => {
    const row = probe.current?.firstElementChild;
    if (row === null || row === undefined) {
      return undefined;
    }
    const read = (): void => {
      const next = row.getBoundingClientRect().height;
      if (next > 0) {
        setHeight(next);
      }
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(row);
    return () => observer.disconnect();
  }, [probe]);
  return height;
}

function RowHeightProbe({
  ref,
}: {
  readonly ref: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div aria-hidden className="lg-library-probe" ref={ref}>
      <div className="lg-library-row">
        <span className="lg-library-row__title">
          <span className="lg-library-row__name">Probe</span>
        </span>
      </div>
    </div>
  );
}

const readInspectorWidth = (): number => {
  const stored = Number(readLocalStorageValue(INSPECTOR_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : INSPECTOR_DEFAULT_PX;
};

const inspectorLimits = (
  space: number,
): { readonly maximum: number; readonly minimum: number } => {
  const rem = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const minimum = INSPECTOR_MIN_REM * rem;
  return { maximum: Math.max(minimum, space - TABLE_MIN_REM * rem), minimum };
};

function Splitter({
  onChange,
  onCommit,
  width,
}: {
  readonly onChange: (width: number) => void;
  readonly onCommit: (width: number) => void;
  readonly width: number;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragged = useRef(width);
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopDrag.current?.(), []);
  useLayoutEffect(() => {
    const split = handle.current?.parentElement;
    if (split === null || split === undefined) {
      return undefined;
    }
    const measure = (): void => setSpace(split.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(split);
    return () => observer.disconnect();
  }, []);

  const clamp = (next: number): number => {
    const { maximum, minimum } = inspectorLimits(
      handle.current?.parentElement?.clientWidth ?? space,
    );
    return Math.round(Math.min(Math.max(next, minimum), maximum));
  };
  const { maximum, minimum } = inspectorLimits(space);
  const current = Math.round(Math.min(Math.max(width, minimum), maximum));

  return (
    <div
      aria-label="Resize details"
      aria-orientation="vertical"
      aria-valuemax={Math.round(maximum)}
      aria-valuemin={Math.round(minimum)}
      aria-valuenow={current}
      className="lg-library-splitter"
      data-dragging={dragging ? "" : undefined}
      onDoubleClick={() => {
        onChange(INSPECTOR_DEFAULT_PX);
        onCommit(INSPECTOR_DEFAULT_PX);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? SPLITTER_STEP_PX * 3 : SPLITTER_STEP_PX;
        const next =
          event.key === "ArrowLeft"
            ? current + step
            : event.key === "ArrowRight"
              ? current - step
              : event.key === "Home"
                ? Number.POSITIVE_INFINITY
                : event.key === "End"
                  ? 0
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          const clamped = clamp(next);
          onChange(clamped);
          onCommit(clamped);
        }
      }}
      onPointerDown={(event) => {
        const right =
          handle.current?.parentElement?.getBoundingClientRect().right;
        if (event.button !== 0 || right === undefined) {
          return;
        }
        event.preventDefault();
        stopDrag.current?.();
        dragged.current = current;
        setDragging(true);
        document.body.style.cursor = "col-resize";
        const move = (moveEvent: PointerEvent): void => {
          dragged.current = clamp(right - moveEvent.clientX);
          onChange(dragged.current);
        };
        const stop = (): void => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
          window.removeEventListener("pointercancel", stop);
          document.body.style.cursor = "";
          stopDrag.current = undefined;
          setDragging(false);
          onCommit(dragged.current);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        stopDrag.current = stop;
      }}
      ref={handle}
      role="separator"
      tabIndex={0}
    />
  );
}

function SidebarSource({
  grabber,
  onSelect,
  selected,
  source,
}: {
  readonly grabber: LoaderGrabber;
  readonly onSelect: () => void;
  readonly selected: boolean;
  readonly source: Source;
}) {
  const state = grabber.states[source];
  const count = lastSnapshot(state)?.entries.length;
  return (
    <li>
      <button
        aria-current={selected ? "page" : undefined}
        className="lg-library-source"
        onClick={onSelect}
        type="button"
      >
        <span className="lg-library-source__label">
          {SOURCES[source].label}
        </span>
        {count === undefined ? null : (
          <span className="lg-library-source__trail lg-count">
            {formatNumber(count)}
          </span>
        )}
      </button>
    </li>
  );
}

function LoadRow({
  autoFocus,
  disabled,
  onLoad,
  pending,
  target,
}: {
  readonly autoFocus: boolean;
  readonly disabled: boolean;
  readonly onLoad: (
    request: LoaderGrabberLoadRequest,
  ) => Promise<string | null>;
  readonly pending: boolean;
  readonly target: OpenTargetInfo;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const field = useId();
  const errorId = `${field}-error`;
  const name = target.label.toLocaleLowerCase();
  const submit = (request: LoaderGrabberLoadRequest): void => {
    setError(null);
    void onLoad(request).then(setError);
  };

  return (
    <form
      className="lg-load-row"
      onSubmit={(event) => {
        event.preventDefault();
        if (target.kind === "direct") {
          submit({ type: target.id });
          return;
        }
        const id = parseIdInput(text);
        if (id === null) {
          setError("Enter an ID of up to 9 digits.");
        } else {
          submit({ id, type: target.id });
        }
      }}
    >
      {target.kind === "by-id" ? (
        <>
          <label className="lg-load-row__label" htmlFor={field}>
            {target.label}
            <span className="lg-sr-only"> ID</span>
          </label>
          <Input
            aria-describedby={error === null ? undefined : errorId}
            aria-invalid={error !== null || undefined}
            autoComplete="off"
            autoFocus={autoFocus}
            className="lg-load-row__input"
            id={field}
            inputMode="numeric"
            onValueChange={(value) => {
              setText(value);
              setError(null);
            }}
            placeholder="ID"
            size="sm"
            spellCheck={false}
            value={text}
          />
        </>
      ) : (
        <span className="lg-load-row__label">{target.label}</span>
      )}
      <Button
        aria-label={`Load ${name}`}
        className="lg-load-row__submit"
        disabled={disabled || (target.kind === "by-id" && text.trim() === "")}
        loading={pending}
        size="sm"
        type="submit"
      >
        Load
      </Button>
      {error === null ? null : (
        <p
          className="lg-form-error lg-load-row__error"
          id={errorId}
          role="alert"
        >
          {error}
        </p>
      )}
    </form>
  );
}

function LoadPopover({
  finalFocus,
  focus,
  onLoad,
  onOpenChange,
  open,
  opening,
}: {
  readonly finalFocus: () => HTMLElement | true;
  readonly focus: OpenTarget;
  readonly onLoad: (
    request: LoaderGrabberLoadRequest,
  ) => Promise<string | null>;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly opening: LoaderGrabberLoadRequest | null;
}) {
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger render={<Button size="sm" />}>
        <Icon aria-hidden icon="plus" size="sm" />
        Load…
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="lg-load-popover"
        finalFocus={finalFocus}
        side="bottom"
      >
        <PopoverTitle className="lg-load-popover__title">Load</PopoverTitle>
        {OPEN_TARGETS.map((target) => (
          <LoadRow
            autoFocus={target.id === focus}
            disabled={opening !== null}
            key={target.id}
            onLoad={onLoad}
            pending={opening?.type === target.id}
            target={target}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function FilterMenu({
  active,
  groups,
  onChange,
}: {
  readonly active: number;
  readonly groups: readonly FilterGroup[];
  readonly onChange: (update: (filters: Filters) => Filters) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            className="lg-filter-trigger"
            size="sm"
            variant={active === 0 ? "ghost" : "soft"}
          />
        }
      >
        <Icon aria-hidden icon="funnel" size="sm" />
        <span className="lg-filter-trigger__label">Filter</span>
        {active === 0 ? null : (
          <span className="lg-count">
            {active}
            <span className="lg-sr-only"> active</span>
          </span>
        )}
      </MenuTrigger>
      <MenuContent align="end" className="lg-filter-menu">
        {groups.map((group, index) => (
          <Fragment key={group.key}>
            {index === 0 ? null : <MenuSeparator />}
            <MenuGroup
              className="lg-filter-menu__group"
              data-scroll={index === groups.length - 1 ? "" : undefined}
            >
              <MenuGroupLabel>{group.label}</MenuGroupLabel>
              <div className="lg-filter-menu__options" tabIndex={-1}>
                {group.options.map((option) => (
                  <MenuCheckboxItem
                    checked={option.selected}
                    className="lg-filter-menu__item"
                    key={option.key}
                    label={option.label}
                    onCheckedChange={() => onChange(option.toggle)}
                  >
                    <span className="lg-filter-menu__label">
                      {option.label}
                    </span>
                    <span className="lg-count lg-filter-menu__count">
                      {option.count}
                    </span>
                  </MenuCheckboxItem>
                ))}
              </div>
            </MenuGroup>
          </Fragment>
        ))}
        {active === 0 ? null : (
          <>
            <MenuSeparator />
            <MenuItem
              className="lg-filter-menu__item"
              onClick={() => onChange(() => NO_FILTERS)}
            >
              Clear filters
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

const rowLabel = (entry: Entry, columns: readonly Column[]): string =>
  [
    entry.title,
    ...entry.badges,
    ...entry.cells.map((cell, index) =>
      [columns[index]?.label, cell].filter(Boolean).join(" "),
    ),
  ].join(", ");

function EntryRow({
  columns,
  count,
  entry,
  height,
  index,
  onSelect,
  query,
  selected,
}: {
  readonly columns: readonly Column[];
  readonly count: number;
  readonly entry: Entry;
  readonly height: number;
  readonly index: number;
  readonly onSelect: () => void;
  readonly query: string;
  readonly selected: boolean;
}) {
  return (
    <div
      aria-label={rowLabel(entry, columns)}
      aria-posinset={index + 1}
      aria-selected={selected}
      aria-setsize={count}
      className="lg-library-row"
      id={`lg-row-${entry.key}`}
      onClick={onSelect}
      onContextMenu={onSelect}
      role="option"
      style={{ height }}
    >
      <span className="lg-library-row__title">
        <span className="lg-library-row__name" title={entry.title}>
          <Highlight query={query} text={entry.title} />
        </span>
        {entry.badges.length === 0 ? null : (
          <TagText badges={entry.badges} className="lg-library-row__tags" />
        )}
      </span>
      {entry.cells.map((cell, cellIndex) => (
        <span
          className="lg-library-row__cell"
          data-kind={columns[cellIndex]?.kind}
          key={columns[cellIndex]?.label ?? cellIndex}
        >
          <Highlight query={query} text={cell} />
        </span>
      ))}
    </div>
  );
}

function Inspector({
  entry,
  query,
}: {
  readonly entry: Entry;
  readonly query: string;
}) {
  return (
    <section
      aria-label={`${entry.title} details`}
      className="lg-library-inspector"
    >
      <header className="lg-library-inspector__header">
        <div className="lg-library-inspector__heading">
          <h2 className="lg-library-inspector__title" title={entry.title}>
            <Highlight query={query} text={entry.title} />
          </h2>
          <Badges badges={entry.badges} />
        </div>
      </header>
      <div className="lg-library-inspector__body">
        <EntryDetail entry={entry} query={query} />
      </div>
    </section>
  );
}

const isContextMenuKey = (event: { key: string; shiftKey: boolean }) =>
  event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

function EntryList({
  allEntries,
  columns,
  criteria,
  entries,
  label,
  listRef,
  onSelect,
  selected,
}: {
  readonly allEntries: readonly Entry[];
  readonly columns: readonly Column[];
  readonly criteria: Criteria;
  readonly entries: readonly Entry[];
  readonly label: string;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly onSelect: (key: string) => void;
  readonly selected: Entry;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const columnStyle = useMemo(
    () => gridColumns(columns, allEntries),
    [allEntries, columns],
  );
  const rowHeight = useRowHeight(probe);
  const getItemKey = useCallback(
    (index: number) => entries[index]?.key ?? index,
    [entries],
  );
  const virtualizer = useVirtualizer({
    count: entries.length,
    estimateSize: () => rowHeight,
    getItemKey,
    getScrollElement: () => scroller.current,
    overscan: LIST_OVERSCAN,
  });

  useLayoutEffect(() => {
    virtualizer.measure();
  }, [entries, rowHeight, virtualizer]);

  const selectedIndex = entries.indexOf(selected);
  const revealIndex = useRef(selectedIndex);
  useLayoutEffect(() => {
    revealIndex.current = selectedIndex;
  });
  useEffect(() => {
    if (revealIndex.current >= 0) {
      virtualizer.scrollToIndex(revealIndex.current, { align: "auto" });
    }
  }, [criteria, virtualizer]);

  const move = (index: number): void => {
    const next = Math.min(entries.length - 1, Math.max(0, index));
    const entry = entries[next];
    if (entry !== undefined) {
      onSelect(entry.key);
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };

  const openRowMenu = (): void => {
    const row = document.getElementById(`lg-row-${selected.key}`);
    if (row === null) {
      return;
    }
    const box = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.height / 2,
        clientY: box.bottom,
      }),
    );
  };

  const virtualRows = virtualizer.getVirtualItems();
  const renderedTop = virtualRows[0]?.start ?? 0;
  const renderedHeight = (virtualRows.at(-1)?.end ?? 0) - renderedTop;
  const viewportHeight = virtualizer.scrollRect?.height ?? 0;
  // The browser can scroll past the rendered rows before React renders the new range.
  // These sticky insets pin the rows to that viewport edge instead of exposing blank space.
  // TanStack rounds the viewport height, so it can exceed the real one by half a pixel.
  const renderedInset = Math.min(0, viewportHeight - 0.5 - renderedHeight);
  const renderedInsets = { bottom: renderedInset, top: renderedInset };
  const selectedRendered = virtualRows.some(
    (item) => item.index === selectedIndex,
  );

  return (
    <div className="lg-library-table" style={columnStyle}>
      <div aria-hidden className="lg-library-row lg-library-row--head">
        <span>Name</span>
        {columns.map((column) => (
          <span data-kind={column.kind} key={column.label}>
            {column.label}
          </span>
        ))}
      </div>
      <ContextMenu>
        <ContextMenuTrigger
          aria-activedescendant={
            selectedRendered ? `lg-row-${selected.key}` : undefined
          }
          aria-label={label}
          className="lg-library-rows"
          onContextMenu={(event) => {
            if (
              !(event.target instanceof Element) ||
              event.target.closest('[role="option"]') === null
            ) {
              event.preventBaseUIHandler();
            }
          }}
          onKeyDown={(event) => {
            if (isContextMenuKey(event)) {
              event.preventDefault();
              if (selectedRendered) {
                openRowMenu();
              } else {
                virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
                requestAnimationFrame(openRowMenu);
              }
              return;
            }
            const page = Math.max(
              1,
              Math.floor(viewportHeight / rowHeight) - 1,
            );
            const next =
              event.key === "ArrowDown"
                ? selectedIndex + 1
                : event.key === "ArrowUp"
                  ? selectedIndex - 1
                  : event.key === "PageDown"
                    ? selectedIndex + page
                    : event.key === "PageUp"
                      ? selectedIndex - page
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? entries.length - 1
                          : undefined;
            if (next !== undefined) {
              event.preventDefault();
              move(next);
            }
          }}
          ref={listRef}
          role="listbox"
          tabIndex={0}
        >
          <div
            className="lg-library-scroll"
            onFocus={() => listRef.current?.focus({ preventScroll: true })}
            ref={scroller}
            tabIndex={-1}
          >
            <div
              className="lg-library-virtual"
              style={{ height: virtualizer.getTotalSize() }}
            >
              <RowHeightProbe ref={probe} />
              <div style={{ height: renderedTop }} />
              <div className="lg-library-rendered" style={renderedInsets}>
                {virtualRows.map((item) => {
                  const entry = entries[item.index];
                  return entry === undefined ? null : (
                    <EntryRow
                      columns={columns}
                      count={entries.length}
                      entry={entry}
                      height={item.size}
                      index={item.index}
                      key={item.key}
                      onSelect={() => onSelect(entry.key)}
                      query={criteria.query}
                      selected={item.index === selectedIndex}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <EntryMenuItems entry={selected} />
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

const SHIFTED_SLASH = { key: "/", shift: true };

const isInOverlay = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('[role="dialog"], [role="menu"]') !== null;

const resultsStatus = (count: number): string =>
  count === 1 ? "1 result" : `${formatNumber(count)} results`;

function SourcePane({
  grabber,
  inspectorWidth,
  onInspectorWidthChange,
  onInspectorWidthCommit,
  onLoad,
  onSelectKey,
  selectedKey,
  source,
}: {
  readonly grabber: LoaderGrabber;
  readonly inspectorWidth: number;
  readonly onInspectorWidthChange: (width: number) => void;
  readonly onInspectorWidthCommit: (width: number) => void;
  readonly onLoad: (target: OpenTarget) => void;
  readonly onSelectKey: (key: string) => void;
  readonly selectedKey: string | undefined;
  readonly source: Source;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filters, setFilters] = useState(NO_FILTERS);
  const searchInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const restoreFocusFrom = useRef<Element | null>(null);
  const { grab } = grabber;
  const state = grabber.states[source];
  const criteria = useMemo(
    () => ({ filters, query: deferredQuery }),
    [deferredQuery, filters],
  );
  const view = useMemo(() => viewOf(state, criteria), [criteria, state]);
  const snapshot = lastSnapshot(state);
  const groups = useMemo(
    () => (snapshot === null ? [] : filterGroups(snapshot.entries, criteria)),
    [criteria, snapshot],
  );
  const activeFilters = activeFilterCount(filters);
  const entries = view.kind === "entries" ? view.entries : [];
  const selected =
    entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null;
  const selectedGone =
    selectedKey !== undefined &&
    snapshot !== null &&
    !snapshot.entries.some((entry) => entry.key === selectedKey);
  const refreshError =
    state.status === "failed" && snapshot !== null ? state.message : null;
  const searching = criteria.query.trim() !== "" || activeFilters > 0;
  const status = !searching
    ? ""
    : view.kind === "entries"
      ? resultsStatus(view.entries.length)
      : view.kind === "no-matches"
        ? "No results"
        : "";

  useEffect(() => {
    if (selectedGone && selected !== null) {
      onSelectKey(selected.key);
    }
  }, [onSelectKey, selected, selectedGone]);

  useLayoutEffect(() => {
    const from = restoreFocusFrom.current;
    const active = document.activeElement;
    if (from === null || (active === from && from.isConnected)) {
      return;
    }
    if (active !== null && active !== document.body) {
      restoreFocusFrom.current = null;
      return;
    }
    const target =
      list.current ?? main.current?.querySelector<HTMLElement>("button");
    if (target !== null && target !== undefined) {
      restoreFocusFrom.current = null;
      target.focus();
    }
  });

  const keepingFocus =
    (action: () => void): (() => void) =>
    () => {
      restoreFocusFrom.current = document.activeElement;
      action();
    };

  const refresh = (): void => {
    void grab(source);
  };

  const exportSnapshot = (): void => {
    if (snapshot !== null && snapshot.entries.length > 0) {
      downloadJson(exportFileName(snapshot), snapshot.data);
    }
  };

  const focusSearch = (event: KeyboardEvent): void => {
    if (event.repeat || event.key !== "/" || isInOverlay(event.target)) {
      return;
    }
    event.preventDefault();
    searchInput.current?.focus();
    searchInput.current?.select();
  };
  useHotkey("/", focusSearch, {
    conflictBehavior: "allow",
    preventDefault: false,
  });
  useHotkey(SHIFTED_SLASH, focusSearch, {
    conflictBehavior: "allow",
    preventDefault: false,
  });

  useHotkey("Mod+E", (event) => {
    if (!event.repeat) {
      exportSnapshot();
    }
  });

  const heading = snapshot?.heading ?? SOURCES[source].label;

  return (
    <>
      <header className="lg-library-toolbar">
        <div className="lg-library-toolbar__title">
          <h1 className="lg-library-toolbar__heading" title={heading}>
            {heading}
          </h1>
          {snapshot === null ? null : (
            <span className="lg-library-toolbar__meta">
              {snapshot.headingFacts.map((fact) => (
                <HeadingId fact={fact} key={fact.label} />
              ))}
              <Badges badges={snapshot.headingBadges} />
            </span>
          )}
        </div>
        <div className="lg-library-toolbar__actions">
          <IconButton
            disabled={state.status === "reading"}
            focusableWhenDisabled
            label="Refresh"
            onClick={refresh}
            size="sm"
          >
            {state.status === "reading" ? (
              <Delayed fallback={<Icon icon="refresh_cw" size="sm" />}>
                <Spinner size={14} />
              </Delayed>
            ) : (
              <Icon icon="refresh_cw" size="sm" />
            )}
          </IconButton>
          <IconButton
            disabled={snapshot === null || snapshot.entries.length === 0}
            label="Export JSON"
            onClick={exportSnapshot}
            size="sm"
          >
            <Icon icon="download" size="sm" />
          </IconButton>
          {groups.length === 0 ? null : (
            <FilterMenu
              active={activeFilters}
              groups={groups}
              onChange={setFilters}
            />
          )}
          <InputGroup className="lg-library-search" size="sm">
            <InputGroupAddon>
              <Icon aria-hidden icon="search" size="sm" />
            </InputGroupAddon>
            <InputGroupInput
              aria-keyshortcuts="/"
              aria-label={`Search ${SOURCES[source].label.toLocaleLowerCase()}`}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query !== "") {
                  event.preventDefault();
                  setQuery("");
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  list.current?.focus();
                }
              }}
              onValueChange={setQuery}
              placeholder="Search"
              ref={searchInput}
              spellCheck={false}
              type="search"
              value={query}
            />
          </InputGroup>
        </div>
      </header>

      <main className="lg-library-main" ref={main}>
        <p aria-live="polite" className="lg-sr-only">
          {status}
        </p>
        {refreshError === null ? null : (
          <p className="lg-inline-error" role="alert">
            <Icon aria-hidden icon="triangle_alert" size="sm" />
            Couldn't refresh. {refreshError}
          </p>
        )}

        {view.kind === "entries" && selected !== null ? (
          <div
            className="lg-library-split"
            style={inspectorStyle(inspectorWidth)}
          >
            <EntryList
              allEntries={view.snapshot.entries}
              columns={view.snapshot.columns}
              criteria={criteria}
              entries={entries}
              label={heading}
              listRef={list}
              onSelect={onSelectKey}
              selected={selected}
            />
            <Splitter
              onChange={onInspectorWidthChange}
              onCommit={onInspectorWidthCommit}
              width={inspectorWidth}
            />
            <Inspector
              entry={selected}
              key={selected.key}
              query={deferredQuery}
            />
          </div>
        ) : view.kind === "entries" ? null : (
          <SourceEmpty
            filtered={activeFilters > 0}
            onClearFilters={keepingFocus(() => setFilters(NO_FILTERS))}
            onClearSearch={() => {
              setQuery("");
              searchInput.current?.focus();
            }}
            onLoad={onLoad}
            onRetry={keepingFocus(refresh)}
            query={deferredQuery}
            source={source}
            view={view}
          />
        )}
      </main>
    </>
  );
}

export function Library({ grabber }: { readonly grabber: LoaderGrabber }) {
  const [source, setSource] = useState<Source | null>(null);
  const [generation, setGeneration] = useState(0);
  const [selection, setSelection] = useState<Partial<Record<Source, string>>>(
    {},
  );
  const [popoverOpen, setPopoverOpen] = useState(false);
  const loadSession = useRef<symbol | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [loadFocus, setLoadFocus] = useState<OpenTarget>("shop");
  const [inspectorWidth, setInspectorWidth] = useState(readInspectorWidth);

  const setLoadOpen = (next: boolean): void => {
    loadSession.current = next ? (loadSession.current ?? Symbol()) : null;
    setPopoverOpen(next);
  };

  const openLoad = (focus: OpenTarget): void => {
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setLoadFocus(focus);
    setLoadOpen(true);
  };

  const select = (next: Source): void => {
    setSource(next);
    void grabber.grab(next);
  };

  const show = (opened: Source, focus: string | null): void => {
    setSource(opened);
    setGeneration((current) => current + 1);
    if (focus !== null) {
      setSelection((current) => ({ ...current, [opened]: focus }));
    }
  };

  const load = async (
    request: LoaderGrabberLoadRequest,
  ): Promise<string | null> => {
    const session = loadSession.current;
    const outcome = await grabber.open(request);
    const waiting = session !== null && session === loadSession.current;
    if (outcome.status === "failed") {
      if (waiting) {
        return outcome.message;
      }
      toast.error(outcome.message);
      return null;
    }
    const { focus, source: opened } = outcome;
    if (waiting) {
      setLoadOpen(false);
    }
    if (waiting && opened !== null) {
      show(opened, focus);
    } else {
      toast.success(
        `${describeOpenRequest(request)} opened`,
        opened === null
          ? undefined
          : { action: { label: "Show", onClick: () => show(opened, focus) } },
      );
    }
    return null;
  };

  const selectKey = useCallback(
    (key: string): void => {
      if (source !== null) {
        setSelection((current) => ({ ...current, [source]: key }));
      }
    },
    [source],
  );

  useHotkey("Mod+O", (event) => {
    if (!event.repeat && !isInOverlay(event.target)) {
      openLoad("shop");
    }
  });

  return (
    <div className="lg-library">
      <div className="lg-library-corner">
        <LoadPopover
          finalFocus={() =>
            opener.current?.isConnected === true ? opener.current : true
          }
          focus={loadFocus}
          onLoad={load}
          onOpenChange={(next) => {
            if (next) {
              opener.current = null;
              setLoadFocus("shop");
            }
            setLoadOpen(next);
          }}
          open={popoverOpen}
          opening={grabber.opening}
        />
      </div>

      <nav aria-label="Sources" className="lg-library-sidebar">
        <ul className="lg-library-sidebar__list">
          {SOURCE_ORDER.map((item) => (
            <SidebarSource
              grabber={grabber}
              key={item}
              onSelect={() => select(item)}
              selected={item === source}
              source={item}
            />
          ))}
        </ul>
      </nav>

      {source === null ? (
        <>
          <div className="lg-library-toolbar" />
          <main className="lg-library-main">
            <Empty className="lg-empty">
              <EmptyTitle render={<h1 />}>Choose a source</EmptyTitle>
              <EmptyDescription>
                Select a source to read it from the game. Your character needs
                to be logged in.
              </EmptyDescription>
            </Empty>
          </main>
        </>
      ) : (
        <SourcePane
          grabber={grabber}
          inspectorWidth={inspectorWidth}
          key={`${source}:${generation}`}
          onInspectorWidthChange={setInspectorWidth}
          onInspectorWidthCommit={(width) =>
            writeLocalStorageValue(INSPECTOR_WIDTH_STORAGE_KEY, String(width))
          }
          onLoad={openLoad}
          onSelectKey={selectKey}
          selectedKey={selection[source]}
          source={source}
        />
      )}
    </div>
  );
}

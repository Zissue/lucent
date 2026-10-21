/** @jsxImportSource react */
import { getItemEnhancementNames } from "@lucent/game";
import {
  Badge,
  Button,
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
  Icon,
  MenuItem,
  Spinner,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@lucent/ui-react";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { splitTextMatches } from "../../lib/text";
import {
  OPEN_TARGETS,
  SOURCES,
  filterEntries,
  type Criteria,
  type Entry,
  type EntryJson,
  type Fact,
  type OpenTarget,
  type Section,
  type Snapshot,
  type Source,
} from "./model";
import { lastSnapshot, type SourceState } from "./useLoaderGrabber";

const COPIED_RESET_MS = 1_200;
const LONG_JSON_VALUE = 28;
const PENDING_INDICATOR_DELAY_MS = 400;

export function Delayed({
  children,
  fallback = null,
}: {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setShown(true),
      PENDING_INDICATOR_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);
  return shown ? children : fallback;
}

export function Highlight({
  query,
  text,
}: {
  readonly query: string;
  readonly text: string;
}) {
  const needle = query.trim();
  if (needle === "") {
    return text;
  }
  return splitTextMatches(text, needle).map((segment, index) =>
    segment.match ? (
      <mark className="lg-mark" key={index}>
        {segment.text}
      </mark>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}

const writeClipboard = (text: string): Promise<boolean> =>
  navigator.clipboard.writeText(text).then(
    () => true,
    (cause: unknown) => {
      window.desktop.log.error("Failed to copy from loader grabber", cause);
      toast.error("Couldn't copy to the clipboard");
      return false;
    },
  );

export function useCopy(): readonly [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = (text: string): void => {
    void writeClipboard(text).then((ok) => {
      if (ok) {
        window.clearTimeout(timer.current);
        setCopied(true);
        timer.current = window.setTimeout(
          () => setCopied(false),
          COPIED_RESET_MS,
        );
      }
    });
  };
  return [copied, copy];
}

export function CopyGlyph({ copied }: { readonly copied: boolean }) {
  return (
    <span
      aria-hidden
      className="lg-copy-glyph"
      data-copied={copied ? "" : undefined}
    >
      <Icon className="lg-copy-glyph__copy" icon="copy" size="xs" />
      <Icon className="lg-copy-glyph__check" icon="check" size="xs" />
    </span>
  );
}

function CopiedAnnouncement({ copied }: { readonly copied: boolean }) {
  return (
    <span aria-live="polite" className="lg-sr-only">
      {copied ? "Copied" : ""}
    </span>
  );
}

export function CopyValue({
  fact,
  hint,
  mono = fact.role === "id",
  query = "",
  tooltip,
}: {
  readonly fact: Fact;
  readonly hint?: string | undefined;
  readonly mono?: boolean;
  readonly query?: string;
  readonly tooltip?: ReactNode;
}) {
  const [copied, copy] = useCopy();
  const button = (
    <button
      aria-label={`Copy ${fact.label}, ${fact.value}`}
      className="lg-copy"
      data-copied={copied ? "" : undefined}
      data-mono={mono ? "" : undefined}
      data-tooltip={tooltip === undefined ? undefined : ""}
      onClick={() => copy(fact.value)}
      type="button"
    >
      <CopyGlyph copied={copied} />
      {hint === undefined ? null : (
        <span className="lg-copy__hint">{hint}</span>
      )}
      <span className="lg-copy__text">
        <Highlight query={query} text={fact.value} />
      </span>
      <CopiedAnnouncement copied={copied} />
    </button>
  );
  return tooltip === undefined ? (
    button
  ) : (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

const RELATIVE_TIME_UNITS: readonly (readonly [
  Intl.RelativeTimeFormatUnit,
  number,
])[] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

const relativeTime = (deltaMs: number): string => {
  const [unit, size] = RELATIVE_TIME_UNITS.find(
    ([, unitMs]) => Math.abs(deltaMs) >= unitMs,
  ) ?? ["second", 1_000];
  return relativeTimeFormat.format(Math.round(deltaMs / size), unit);
};

function ExpiresIn({ at }: { readonly at: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const delta = at - now;
  return delta >= 0
    ? `Expires ${relativeTime(delta)}`
    : `Expired ${relativeTime(delta)}`;
}

export function HeadingId({ fact }: { readonly fact: Fact }) {
  const [copied, copy] = useCopy();
  return (
    <button
      aria-label={`Copy ${fact.label} ${fact.value}`}
      className="lg-heading-id"
      onClick={() => copy(fact.value)}
      type="button"
    >
      {fact.label}
      <span className="lg-heading-id__value">{fact.value}</span>
      <CopyGlyph copied={copied} />
      <CopiedAnnouncement copied={copied} />
    </button>
  );
}

const AC_BADGE = "AC";

function AcMark() {
  return <span className="lg-ac">AC</span>;
}

export function Badges({ badges }: { readonly badges: readonly string[] }) {
  return badges.length === 0 ? null : (
    <span className="lg-badges">
      {badges.map((badge) =>
        badge === AC_BADGE ? (
          <Badge className="lg-ac-badge" key={badge} size="sm">
            <AcMark />
          </Badge>
        ) : (
          <Badge key={badge} size="sm">
            {badge}
          </Badge>
        ),
      )}
    </span>
  );
}

export function TagText({
  badges,
  className,
}: {
  readonly badges: readonly string[];
  readonly className: string;
}) {
  return (
    <span className={className}>
      {badges.map((badge, index) => (
        <Fragment key={badge}>
          {index === 0 ? null : " · "}
          {badge === AC_BADGE ? <AcMark /> : badge}
        </Fragment>
      ))}
    </span>
  );
}

function FactRows({
  facts,
  query,
}: {
  readonly facts: readonly Fact[];
  readonly query: string;
}) {
  return facts.map((fact) => (
    <div
      className="lg-fact"
      data-long={fact.role === "note" ? "" : undefined}
      data-role={fact.role}
      key={fact.label}
    >
      <dt className="lg-fact__label">{fact.label}</dt>
      <dd className="lg-fact__value">
        <CopyValue
          fact={fact}
          query={query}
          tooltip={
            fact.expiresAt === undefined ? undefined : (
              <ExpiresIn at={fact.expiresAt} />
            )
          }
        />
      </dd>
    </div>
  ));
}

function Group({
  children,
  count,
  title,
}: {
  readonly children: ReactNode;
  readonly count?: number;
  readonly title: string;
}) {
  return (
    <section className="lg-group">
      <h3 className="lg-group__title">
        {title}
        {count === undefined ? null : <span className="lg-count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function NestedEntry({
  columns,
  entry,
  query,
}: {
  readonly columns: Section["columns"];
  readonly entry: Entry;
  readonly query: string;
}) {
  const [open, setOpen] = useState(false);
  const meta = entry.cells.flatMap((cell, index) => {
    const column = columns[index];
    return column === undefined || column.kind === "id"
      ? []
      : [{ label: column.label, value: cell }];
  });
  return (
    <li className="lg-nested" data-open={open ? "" : undefined}>
      <button
        aria-expanded={open}
        className="lg-nested__row"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Icon
          aria-hidden
          className="lg-nested__chevron"
          icon="chevron_right"
          size="xs"
        />
        <span className="lg-nested__title" title={entry.title}>
          <Highlight query={query} text={entry.title} />
        </span>
        {entry.badges.length === 0 ? null : (
          <TagText badges={entry.badges} className="lg-nested__tags" />
        )}
        {meta.map((part) => (
          <span className="lg-nested__meta" key={part.label}>
            <span className="lg-nested__meta-label">{part.label}</span>
            {part.value}
          </span>
        ))}
      </button>
      {open ? (
        <div className="lg-nested__detail">
          <dl className="lg-facts">
            <FactRows facts={entry.facts} query={query} />
          </dl>
        </div>
      ) : null}
    </li>
  );
}

type JsonBranch = Readonly<Record<string, unknown>> | readonly unknown[];

const isBranch = (value: unknown): value is JsonBranch =>
  typeof value === "object" && value !== null;

const branchEntries = (value: JsonBranch): readonly [string, unknown][] =>
  Array.isArray(value)
    ? value.map((item, index) => [`[${index}]`, item])
    : Object.entries(value);

const leafText = (value: unknown): string =>
  value === "" ? '""' : typeof value === "string" ? value : String(value);

const branchSummary = (value: JsonBranch): string => {
  if (Array.isArray(value)) {
    return value.length === 1 ? "1 item" : `${value.length} items`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const item = record["item"];
  const name =
    record["name"] ??
    (isBranch(item) && !Array.isArray(item)
      ? (item as Readonly<Record<string, unknown>>)["name"]
      : undefined);
  if (typeof name === "string" && name !== "") {
    return name;
  }
  const size = Object.keys(value).length;
  return size === 1 ? "1 field" : `${size} fields`;
};

const indentStyle = (
  depth: number,
): CSSProperties & Record<"--lg-depth", number> => ({ "--lg-depth": depth });

const ENHANCEMENT_KEY = "enhancement";
const EXPIRES_AT_KEY = "expiresAt";
const UNRESOLVED_ENHANCEMENT_NAME = /^(Pattern|Proc) \d+$/u;

const resolvedName = (name: string | undefined): string | undefined =>
  name === undefined || UNRESOLVED_ENHANCEMENT_NAME.test(name)
    ? undefined
    : name;

const enhancementHints = (
  value: JsonBranch,
): Readonly<Record<string, string | undefined>> => {
  const record = value as Readonly<Record<string, unknown>>;
  const patternId = record["patternId"];
  const procId = record["procId"];
  const names = getItemEnhancementNames({
    ...(typeof patternId === "number" ? { patternId } : {}),
    ...(typeof procId === "number" ? { procId } : {}),
  });
  const name = resolvedName(names.name);
  const special = resolvedName(names.special);
  if (typeof procId === "number" && procId > 0) {
    return { patternId: name, procId: special };
  }
  const fromPattern = [name, special].filter((part) => part !== undefined);
  return {
    patternId: fromPattern.length === 0 ? undefined : fromPattern.join(" · "),
  };
};

function JsonRows({
  depth,
  hints,
  value,
}: {
  readonly depth: number;
  readonly hints?: Readonly<Record<string, string | undefined>> | undefined;
  readonly value: JsonBranch;
}) {
  return branchEntries(value).map(([label, item]) => (
    <JsonRow
      depth={depth}
      hint={hints?.[label]}
      key={label}
      label={label}
      value={item}
    />
  ));
}

function JsonRow({
  depth,
  hint,
  label,
  value,
}: {
  readonly depth: number;
  readonly hint?: string | undefined;
  readonly label: string;
  readonly value: unknown;
}) {
  const [open, setOpen] = useState(false);
  if (isBranch(value) && branchEntries(value).length > 0) {
    const hints =
      label === ENHANCEMENT_KEY && !Array.isArray(value)
        ? enhancementHints(value)
        : undefined;
    const resolved = [hints?.["patternId"], hints?.["procId"]].filter(
      (name) => name !== undefined,
    );
    return (
      <>
        <div
          className="lg-fact lg-json-row"
          data-open={open ? "" : undefined}
          style={indentStyle(depth)}
        >
          <dt className="lg-fact__label lg-json-row__key">
            <button
              aria-expanded={open}
              className="lg-json-row__toggle"
              onClick={() => setOpen((current) => !current)}
              type="button"
            >
              <Icon
                aria-hidden
                className="lg-json-row__chevron"
                icon="chevron_right"
                size="xs"
              />
              {label}
            </button>
          </dt>
          <dd className="lg-fact__value lg-json-row__summary">
            {resolved.length > 0 ? resolved.join(" · ") : branchSummary(value)}
          </dd>
        </div>
        {open ? (
          <JsonRows depth={depth + 1} hints={hints} value={value} />
        ) : null}
      </>
    );
  }
  const text = isBranch(value)
    ? Array.isArray(value)
      ? "[]"
      : "{}"
    : leafText(value);
  return (
    <div
      className="lg-fact lg-json-row"
      data-kind={typeof value === "string" ? "string" : "literal"}
      data-long={text.length > LONG_JSON_VALUE ? "" : undefined}
      style={indentStyle(depth)}
    >
      <dt className="lg-fact__label lg-json-row__key">{label}</dt>
      <dd className="lg-fact__value">
        <CopyValue
          fact={{ label, role: "property", value: text }}
          hint={hint}
          mono
          tooltip={
            label === EXPIRES_AT_KEY && typeof value === "number" ? (
              <ExpiresIn at={value} />
            ) : undefined
          }
        />
      </dd>
    </div>
  );
}

function AllFields({ json }: { readonly json: EntryJson }) {
  const [open, setOpen] = useState(false);
  const [copied, copy] = useCopy();
  return (
    <section className="lg-group">
      <div className="lg-group__header">
        <h3 className="lg-group__title">
          <button
            aria-expanded={open}
            className="lg-group__toggle"
            onClick={() => setOpen(!open)}
            type="button"
          >
            <Icon
              aria-hidden
              className="lg-group__chevron"
              icon="chevron_right"
              size="xs"
            />
            All fields
          </button>
          <span className="lg-count">{Object.keys(json).length}</span>
        </h3>
        <Button
          aria-label="Copy JSON"
          className="lg-group__action"
          onClick={() => copy(JSON.stringify(json, null, 2))}
          size="sm"
          variant="ghost"
        >
          <CopyGlyph copied={copied} />
          <span className="lg-group__action-label">Copy JSON</span>
          <CopiedAnnouncement copied={copied} />
        </Button>
      </div>
      {open ? (
        <dl className="lg-card lg-facts">
          <JsonRows depth={0} value={json} />
        </dl>
      ) : null}
    </section>
  );
}

export function EntryDetail({
  entry,
  query,
}: {
  readonly entry: Entry;
  readonly query: string;
}) {
  return (
    <div className="lg-detail">
      {entry.facts.length === 0 ? null : (
        <dl className="lg-card lg-facts">
          <FactRows facts={entry.facts} query={query} />
        </dl>
      )}
      {entry.sections.map((section) => (
        <Group
          count={section.entries.length}
          key={section.title}
          title={section.title}
        >
          <ul className="lg-card lg-nested-list">
            {section.entries.map((child) => (
              <NestedEntry
                columns={section.columns}
                entry={child}
                key={child.key}
                query={query}
              />
            ))}
          </ul>
        </Group>
      ))}
      <AllFields json={entry.json} />
    </div>
  );
}

const sentenceLabel = (label: string): string =>
  /^[A-Z][a-z]+ /u.test(label)
    ? `${label.charAt(0).toLocaleLowerCase()}${label.slice(1)}`
    : label;

const copyWithToast = (what: string, text: string): void => {
  void writeClipboard(text).then((ok) => {
    if (ok) {
      toast.success(`Copied ${what}`);
    }
  });
};

export function EntryMenuItems({ entry }: { readonly entry: Entry }) {
  const idLabel = sentenceLabel(entry.primary.label);
  return (
    <>
      <MenuItem onClick={() => copyWithToast("name", entry.title)}>
        Copy name
      </MenuItem>
      <MenuItem onClick={() => copyWithToast(idLabel, entry.primary.value)}>
        Copy {idLabel}
      </MenuItem>
    </>
  );
}

export type SourceView =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "empty" }
  | { readonly kind: "no-matches" }
  | {
      readonly kind: "entries";
      readonly snapshot: Snapshot;
      readonly entries: readonly Entry[];
    };

export const viewOf = (state: SourceState, criteria: Criteria): SourceView => {
  const snapshot = lastSnapshot(state);
  if (snapshot === null) {
    switch (state.status) {
      case "idle":
        return { kind: "idle" };
      case "missing":
        return { kind: "missing" };
      case "failed":
        return { kind: "failed", message: state.message };
      case "reading":
      case "ready":
        return { kind: "loading" };
    }
  }
  if (snapshot.entries.length === 0) {
    return { kind: "empty" };
  }
  const entries = filterEntries(snapshot.entries, criteria);
  return entries.length === 0
    ? { kind: "no-matches" }
    : { entries, kind: "entries", snapshot };
};

export function SourceEmpty({
  filtered,
  onClearFilters,
  onClearSearch,
  onLoad,
  onRetry,
  query,
  source,
  view,
}: {
  readonly filtered: boolean;
  readonly onClearFilters: () => void;
  readonly onClearSearch: () => void;
  readonly onLoad?: (target: OpenTarget) => void;
  readonly onRetry: () => void;
  readonly query: string;
  readonly source: Source;
  readonly view: Exclude<SourceView, { readonly kind: "entries" }>;
}) {
  const info = SOURCES[source];
  const label = info.label.toLocaleLowerCase();
  const loadTarget = OPEN_TARGETS.find((target) => target.opens === source);
  const loadAction =
    onLoad === undefined || loadTarget === undefined ? null : (
      <Button onClick={() => onLoad(loadTarget.id)} size="sm" variant="primary">
        Load a {loadTarget.label.toLocaleLowerCase()}
      </Button>
    );
  const title = <h2 />;
  let content: ReactNode;
  switch (view.kind) {
    case "idle":
      content = (
        <>
          <EmptyTitle render={title}>{info.label}</EmptyTitle>
          <EmptyDescription>
            Read it from the game when you're logged in.
          </EmptyDescription>
          <EmptyActions>
            <Button onClick={onRetry} size="sm">
              Read {label}
            </Button>
          </EmptyActions>
        </>
      );
      break;
    case "loading":
      content = (
        <Delayed>
          <EmptyMedia variant="plain">
            <Spinner size={20} />
          </EmptyMedia>
          <EmptyDescription>Reading {label}…</EmptyDescription>
        </Delayed>
      );
      break;
    case "missing": {
      const missing = info.missing ?? {
        description: "The game didn't return anything. Refresh to try again.",
        title: `No ${label} found`,
      };
      content = (
        <>
          <EmptyTitle render={title}>{missing.title}</EmptyTitle>
          <EmptyDescription>{missing.description}</EmptyDescription>
          <EmptyActions>
            {loadAction}
            <Button onClick={onRetry} size="sm">
              Refresh
            </Button>
          </EmptyActions>
        </>
      );
      break;
    }
    case "failed":
      content = (
        <>
          <EmptyTitle render={title}>Couldn't read {label}</EmptyTitle>
          <EmptyDescription>{view.message}</EmptyDescription>
          <EmptyActions>
            <Button onClick={onRetry} size="sm">
              Try again
            </Button>
          </EmptyActions>
        </>
      );
      break;
    case "empty":
      content = (
        <>
          <EmptyTitle render={title}>{info.empty.title}</EmptyTitle>
          <EmptyDescription>{info.empty.description}</EmptyDescription>
          <EmptyActions>
            {loadAction}
            <Button onClick={onRetry} size="sm">
              Refresh
            </Button>
          </EmptyActions>
        </>
      );
      break;
    case "no-matches": {
      const searched = query.trim() !== "";
      content = (
        <>
          <EmptyTitle render={title}>
            {searched
              ? `No results for “${query.trim()}”`
              : "No items match these filters"}
          </EmptyTitle>
          <EmptyActions>
            {searched ? (
              <Button onClick={onClearSearch} size="sm">
                Clear search
              </Button>
            ) : null}
            {filtered ? (
              <Button onClick={onClearFilters} size="sm">
                Clear filters
              </Button>
            ) : null}
          </EmptyActions>
        </>
      );
      break;
    }
  }
  return (
    <Empty aria-live="polite" className="lg-empty">
      {content}
    </Empty>
  );
}

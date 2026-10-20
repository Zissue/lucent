/** @jsxImportSource react */
import {
  Button,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@lucent/ui-react";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import type {
  CombatProfile,
  CombatProfileCooldownMode,
  CombatProfileStep,
  SkillSlot,
} from "@lucent/core/combatProfiles";
import {
  ConditionLabel,
  InvalidRequestContext,
  SkillKey,
  SkillSelect,
  StepSettings,
} from "./controls";
import {
  SKILL_SLOTS,
  cloneStep,
  createStep,
  describeStep,
  formatDuration,
  insertAt,
  isConditionComplete,
  moveItem,
  removeAt,
  replaceAt,
  skillName,
} from "./profileModel";
import type { ProfileEditor } from "./useProfileEditor";

type Update = ProfileEditor["update"];
type Steps = readonly CombatProfileStep[];

const DRAG_THRESHOLD_PX = 4;

const hasTiming = (
  step: CombatProfileStep,
  defaultMode: CombatProfileCooldownMode,
): boolean =>
  (step.waitMs !== undefined && step.waitMs > 0) ||
  (step.cooldownMode !== undefined && step.cooldownMode !== defaultMode);

interface DragSession {
  readonly from: number;
  readonly grabX: number;
  readonly grabY: number;
  readonly originX: number;
  readonly originY: number;
  readonly pointerId: number;
  active: boolean;
}

interface Indicator {
  readonly height: number;
  readonly left: number;
  readonly top: number;
}

interface DragView {
  readonly from: number;
  readonly indicator: Indicator | null;
  readonly to: number;
  readonly x: number;
  readonly y: number;
}

export function RotationSection({
  draft,
  update,
}: {
  readonly draft: CombatProfile;
  readonly update: Update;
}) {
  const steps = draft.steps;
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragView | null>(null);
  const keys = useRef(new Map<number, HTMLButtonElement>());
  const track = useRef<HTMLDivElement>(null);
  const session = useRef<DragSession | null>(null);
  const suppressClick = useRef(false);
  const pendingFocus = useRef<number | "add" | null>(null);
  const section = useRef<HTMLElement>(null);
  const current =
    selected === null || steps.length === 0
      ? null
      : Math.min(selected, steps.length - 1);
  const tabbable = current ?? 0;

  const invalidRequest = useContext(InvalidRequestContext);
  const [seenInvalidRequest, setSeenInvalidRequest] = useState(invalidRequest);
  const [revealRule, setRevealRule] = useState(false);
  if (invalidRequest !== seenInvalidRequest) {
    setSeenInvalidRequest(invalidRequest);
    const firstIncomplete = steps.findIndex(
      (entry) => !entry.conditions.every(isConditionComplete),
    );
    if (firstIncomplete !== -1) {
      setSelected(firstIncomplete);
      setRevealRule(true);
    }
  }

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "add") {
      section.current?.querySelector<HTMLElement>(".cp-builder-add")?.focus();
    } else if (target !== null) {
      keys.current.get(target)?.focus();
    }
  });

  useEffect(() => {
    if (revealRule) {
      setRevealRule(false);
      section.current
        ?.querySelector<HTMLElement>(
          ".cp-builder-inspector .cp-chip[data-incomplete]",
        )
        ?.focus();
    }
  }, [revealRule]);

  const setSteps = (recipe: (steps: Steps) => Steps) =>
    update((profile) => ({ ...profile, steps: recipe(profile.steps) }));

  const select = (index: number | null, focus = false) => {
    setSelected(index);
    if (focus) {
      pendingFocus.current = index;
    }
  };

  const move = (from: number, to: number, focus = false) => {
    if (to < 0 || to >= steps.length || from === to) {
      return;
    }
    setSteps((all) => moveItem(all, from, to));
    select(to, focus);
  };

  const remove = (index: number, focus = false) => {
    setSteps((all) => removeAt(all, index));
    if (steps.length > 1) {
      select(Math.max(0, Math.min(index, steps.length - 2)), focus);
    } else {
      select(null);
      pendingFocus.current = "add";
    }
  };

  const add = (skill: SkillSlot) => {
    setSteps((all) => [...all, createStep(skill)]);
    select(steps.length);
  };

  const changeStep = (index: number, next: CombatProfileStep) =>
    setSteps((all) => replaceAt(all, index, () => next));

  const dropTarget = (x: number, y: number, from: number) => {
    const container = track.current;
    const others = steps
      .map((_, index) => index)
      .filter((index) => index !== from)
      .flatMap((index) => {
        const rect = keys.current.get(index)?.getBoundingClientRect();
        return rect === undefined ? [] : [{ index, rect }];
      });
    if (container === null || others.length === 0) {
      return { indicator: null, to: from };
    }

    const rowTops = [
      ...new Set(others.map((other) => Math.round(other.rect.top))),
    ];
    const rowTop = rowTops.reduce((best, top) => {
      const height = others[0]!.rect.height;
      const distance = Math.abs(y - (top + height / 2));
      const bestDistance = Math.abs(y - (best + height / 2));
      return distance < bestDistance ? top : best;
    }, rowTops[0]!);
    const row = others.filter((other) => Math.round(other.rect.top) === rowTop);
    const before = others.filter(
      (other) => Math.round(other.rect.top) < rowTop,
    ).length;
    const inRow = row.filter(
      (other) => other.rect.left + other.rect.width / 2 < x,
    ).length;
    const to = before + inRow;

    const bounds = container.getBoundingClientRect();
    const next = row[inRow];
    const previous = row[inRow - 1];
    const edge =
      next !== undefined
        ? next.rect.left - 7
        : previous !== undefined
          ? previous.rect.right + 7
          : null;
    const anchor = next ?? previous;
    return {
      indicator:
        edge === null || anchor === undefined
          ? null
          : {
              height: anchor.rect.height,
              left: edge - bounds.left,
              top: anchor.rect.top - bounds.top,
            },
      to,
    };
  };

  const cancelDrag = () => {
    if (session.current?.active === true) {
      suppressClick.current = true;
    }
    session.current = null;
    setDrag(null);
  };

  const onPointerDown = (
    index: number,
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    suppressClick.current = false;
    const rect = event.currentTarget.getBoundingClientRect();
    session.current = {
      active: false,
      from: index,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      originX: event.clientX,
      originY: event.clientY,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const active = session.current;
    if (active === null || active.pointerId !== event.pointerId) {
      return;
    }
    if (!active.active) {
      if (
        Math.hypot(
          event.clientX - active.originX,
          event.clientY - active.originY,
        ) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      active.active = true;
      setSelected(active.from);
    }
    const target = dropTarget(event.clientX, event.clientY, active.from);
    setDrag({
      from: active.from,
      indicator: target.to === active.from ? null : target.indicator,
      to: target.to,
      x: event.clientX - active.grabX,
      y: event.clientY - active.grabY,
    });
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const active = session.current;
    if (active === null || active.pointerId !== event.pointerId) {
      return;
    }
    session.current = null;
    if (!active.active) {
      return;
    }
    suppressClick.current = true;
    const target = dropTarget(event.clientX, event.clientY, active.from);
    setDrag(null);
    move(active.from, target.to, true);
  };

  const onKeyDown = (
    index: number,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    const last = steps.length - 1;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const to = index + (event.key === "ArrowLeft" ? -1 : 1);
        if (event.altKey) {
          move(index, to, true);
        } else if (to >= 0 && to <= last) {
          select(to, true);
        }
        break;
      }
      case "Home":
        select(0, true);
        break;
      case "End":
        select(last, true);
        break;
      case "Delete":
      case "Backspace":
        if (!event.repeat) {
          remove(index, true);
        }
        break;
      case "Escape":
        if (session.current !== null) {
          cancelDrag();
        } else {
          select(null);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const step = current === null ? undefined : steps[current];
  const dragged = drag === null ? undefined : steps[drag.from];

  return (
    <section
      aria-labelledby="cp-builder-title"
      className="cp-group"
      ref={section}
    >
      <header className="cp-group__header">
        <div className="cp-builder-heading">
          <h2 className="cp-group__title" id="cp-builder-title">
            Rotation
          </h2>
          <span aria-hidden className="cp-builder-legend">
            <span className="cp-builder-legend__item">
              <span className="cp-builder-legend__swatch" />
              Priority
            </span>
            <span className="cp-builder-legend__item">
              <Icon icon="funnel" size={11} />
              Rules
            </span>
            <span className="cp-builder-legend__item">
              <Icon icon="clock" size={11} />
              Timing
            </span>
          </span>
        </div>
        <AddKeyMenu onAdd={add} />
      </header>
      <div className="cp-group__card cp-builder">
        <div className="cp-builder-tray">
          <div
            className="cp-builder-keys"
            data-sorting={drag === null ? undefined : ""}
            ref={track}
          >
            <div
              aria-label="Rotation"
              aria-orientation="horizontal"
              className="cp-builder-list"
              role="listbox"
            >
              {steps.map((entry, index) => {
                const description = describeStep(entry, draft.cooldownMode);
                return (
                  <Tooltip key={index}>
                    <TooltipTrigger
                      render={
                        <button
                          aria-label={description}
                          aria-selected={index === current}
                          className="cp-builder-key"
                          data-dragging={drag?.from === index ? "" : undefined}
                          data-priority={
                            entry.priority === true ? "" : undefined
                          }
                          data-skill={entry.skill}
                          onClick={() => {
                            if (suppressClick.current) {
                              suppressClick.current = false;
                              return;
                            }
                            select(index === current ? null : index);
                          }}
                          onKeyDown={(event) => onKeyDown(index, event)}
                          onLostPointerCapture={() => {
                            if (session.current !== null) {
                              cancelDrag();
                            }
                          }}
                          onPointerCancel={cancelDrag}
                          onPointerDown={(event) => onPointerDown(index, event)}
                          onPointerMove={onPointerMove}
                          onPointerUp={onPointerUp}
                          ref={(element) => {
                            if (element === null) {
                              keys.current.delete(index);
                            } else {
                              keys.current.set(index, element);
                            }
                          }}
                          role="option"
                          tabIndex={index === tabbable ? 0 : -1}
                          type="button"
                        />
                      }
                    >
                      <SkillKey size="lg" skill={entry.skill} />
                      <KeyMarks
                        rules={entry.conditions.length > 0}
                        timing={hasTiming(entry, draft.cooldownMode)}
                      />
                    </TooltipTrigger>
                    <TooltipContent className="cp-builder-tip">
                      <StepSummary
                        defaultMode={draft.cooldownMode}
                        step={entry}
                      />
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
            {drag?.indicator == null ? null : (
              <span
                aria-hidden
                className="cp-builder-indicator"
                style={{
                  height: drag.indicator.height,
                  left: drag.indicator.left,
                  top: drag.indicator.top,
                }}
              />
            )}
          </div>
          {steps.length === 0 ? (
            <p className="cp-builder-empty">
              <span className="cp-builder-empty__title">
                No rotation skills
              </span>
              Add a skill to define this profile's rotation.
            </p>
          ) : null}
        </div>
        {steps.length > 0 && current === null ? (
          <p className="cp-builder-hint">
            Select a skill to edit its rules, priority, cooldown, and delay.
          </p>
        ) : null}
        {step === undefined || current === null ? null : (
          <Inspector
            count={steps.length}
            index={current}
            onChange={(next) => changeStep(current, next)}
            onDuplicate={() => {
              setSteps((all) => insertAt(all, current + 1, cloneStep(step)));
              select(current + 1);
            }}
            onMove={(delta) => move(current, current + delta)}
            onRemove={() => remove(current, true)}
            step={step}
          />
        )}
      </div>
      {drag === null || dragged === undefined ? null : (
        <div
          aria-hidden
          className="cp-builder-ghost"
          data-priority={dragged.priority === true ? "" : undefined}
          style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }}
        >
          <SkillKey size="lg" skill={dragged.skill} />
        </div>
      )}
    </section>
  );
}

const SUMMARY_RULE_LIMIT = 5;

function StepSummary({
  defaultMode,
  step,
}: {
  readonly defaultMode: CombatProfileCooldownMode;
  readonly step: CombatProfileStep;
}) {
  const rules = step.conditions;
  const timing = [
    ...(step.waitMs === undefined || step.waitMs === 0
      ? []
      : [`Delay ${formatDuration(step.waitMs)}`]),
    ...(step.cooldownMode === undefined || step.cooldownMode === defaultMode
      ? []
      : [
          step.cooldownMode === "wait-for-cooldown"
            ? "Wait for cooldown"
            : "Skip if unavailable",
        ]),
  ];
  return (
    <>
      <span className="cp-builder-tip__title">
        {skillName(step.skill)}
        {step.priority === true ? " · Priority" : ""}
      </span>
      {rules.slice(0, SUMMARY_RULE_LIMIT).map((rule, index) => (
        <ConditionLabel condition={rule} key={index} />
      ))}
      {rules.length > SUMMARY_RULE_LIMIT ? (
        <span className="cp-builder-tip__muted">
          +{rules.length - SUMMARY_RULE_LIMIT} more
        </span>
      ) : null}
      {timing.length === 0 ? null : (
        <span className="cp-builder-tip__muted">{timing.join(" · ")}</span>
      )}
    </>
  );
}

function KeyMarks({
  rules,
  timing,
}: {
  readonly rules: boolean;
  readonly timing: boolean;
}) {
  return rules || timing ? (
    <span aria-hidden className="cp-builder-key__marks">
      {rules ? <Icon icon="funnel" size={9} /> : null}
      {timing ? <Icon icon="clock" size={9} /> : null}
    </span>
  ) : null;
}

function AddKeyMenu({ onAdd }: { readonly onAdd: (skill: SkillSlot) => void }) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button className="cp-builder-add" size="sm" variant="ghost" />}
      >
        <Icon icon="plus" size="sm" />
        Skill
      </MenuTrigger>
      <MenuContent align="end" className="cp-skill-menu">
        {SKILL_SLOTS.map((slot) => (
          <MenuItem key={slot} onClick={() => onAdd(slot)}>
            {slot}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function Inspector({
  count,
  index,
  onChange,
  onDuplicate,
  onMove,
  onRemove,
  step,
}: {
  readonly count: number;
  readonly index: number;
  readonly onChange: (step: CombatProfileStep) => void;
  readonly onDuplicate: () => void;
  readonly onMove: (delta: number) => void;
  readonly onRemove: () => void;
  readonly step: CombatProfileStep;
}) {
  return (
    <div
      aria-label={`Step ${index + 1}`}
      className="cp-builder-inspector"
      role="group"
    >
      <div className="cp-builder-inspector__header">
        <span aria-hidden className="cp-settings__label">
          Skill
        </span>
        <SkillSelect
          aria-label="Skill"
          onValueChange={(skill) => onChange({ ...step, skill })}
          value={step.skill}
        />
        <div className="cp-builder-inspector__actions">
          <IconButton
            disabled={index === 0}
            focusableWhenDisabled
            label="Move left"
            onClick={() => onMove(-1)}
            size="sm"
          >
            <Icon icon="chevron_left" size="md" />
          </IconButton>
          <IconButton
            disabled={index === count - 1}
            focusableWhenDisabled
            label="Move right"
            onClick={() => onMove(1)}
            size="sm"
          >
            <Icon icon="chevron_right" size="md" />
          </IconButton>
          <IconButton label="Duplicate" onClick={onDuplicate} size="sm">
            <Icon icon="files" size="md" />
          </IconButton>
          <IconButton
            className="cp-builder-remove"
            label="Remove"
            onClick={onRemove}
            size="sm"
          >
            <Icon icon="x" size="md" />
          </IconButton>
        </div>
      </div>
      <StepSettings key={index} onChange={onChange} step={step} />
    </div>
  );
}

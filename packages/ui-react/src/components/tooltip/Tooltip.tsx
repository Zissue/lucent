import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn, type WithClassName } from "../../lib/cn";
import styles from "./Tooltip.module.css";

export function TooltipProvider(props: TooltipProviderProps) {
  return <BaseTooltip.Provider {...props} delay={200} closeDelay={0} />;
}

export type TooltipProviderProps = BaseTooltip.Provider.Props;

export const Tooltip = BaseTooltip.Root;
export type TooltipProps = BaseTooltip.Root.Props;

export const TooltipTrigger = BaseTooltip.Trigger;
export type TooltipTriggerProps = BaseTooltip.Trigger.Props;

export interface TooltipContentProps
  extends
    WithClassName<BaseTooltip.Popup.Props>,
    Pick<
      BaseTooltip.Positioner.Props,
      "align" | "alignOffset" | "collisionPadding" | "side" | "sideOffset"
    > {}

export function TooltipContent({
  align = "center",
  alignOffset = 0,
  className,
  collisionPadding = 8,
  side = "top",
  sideOffset = 6,
  ...props
}: TooltipContentProps) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner
        align={align}
        alignOffset={alignOffset}
        className={styles.positioner}
        collisionPadding={collisionPadding}
        side={side}
        sideOffset={sideOffset}
      >
        <BaseTooltip.Popup {...props} className={cn(styles.popup, className)} />
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}

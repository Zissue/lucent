import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentProps } from "react";
import { cn, type WithClassName } from "../../lib/cn";
import { Icon } from "../icon/Icon";
import popup from "../../styles/popup.module.css";
import styles from "./Menu.module.css";

export const Menu = BaseMenu.Root;
export type MenuProps = BaseMenu.Root.Props;

export const MenuTrigger = BaseMenu.Trigger;
export type MenuTriggerProps = BaseMenu.Trigger.Props;

export const createMenuHandle = BaseMenu.createHandle;

export const MenuSubmenu = BaseMenu.SubmenuRoot;
export type MenuSubmenuProps = BaseMenu.SubmenuRoot.Props;

export const MenuRadioGroup = BaseMenu.RadioGroup;
export type MenuRadioGroupProps = BaseMenu.RadioGroup.Props;

type PositionerOptions = Pick<
  BaseMenu.Positioner.Props,
  "align" | "alignOffset" | "collisionPadding" | "side" | "sideOffset"
>;

export interface MenuContentProps
  extends WithClassName<BaseMenu.Popup.Props>, PositionerOptions {}

export function MenuContent({
  align = "start",
  alignOffset = 0,
  className,
  collisionPadding = 8,
  side = "bottom",
  sideOffset = 4,
  ...props
}: MenuContentProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        align={align}
        alignOffset={alignOffset}
        className={popup.positioner}
        collisionPadding={collisionPadding}
        side={side}
        sideOffset={sideOffset}
      >
        <BaseMenu.Popup
          {...props}
          className={cn(popup.popup, styles.popup, className)}
        />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export type MenuItemVariant = "default" | "danger";

export interface MenuItemProps extends WithClassName<BaseMenu.Item.Props> {
  readonly variant?: MenuItemVariant;
}

export function MenuItem({
  className,
  variant = "default",
  ...props
}: MenuItemProps) {
  return (
    <BaseMenu.Item
      {...props}
      className={cn(popup.item, className)}
      data-variant={variant}
    />
  );
}

export type MenuLinkItemProps = WithClassName<BaseMenu.LinkItem.Props>;

export function MenuLinkItem({ className, ...props }: MenuLinkItemProps) {
  return <BaseMenu.LinkItem {...props} className={cn(popup.item, className)} />;
}

export type MenuCheckboxItemProps = WithClassName<BaseMenu.CheckboxItem.Props>;

export function MenuCheckboxItem({
  children,
  className,
  ...props
}: MenuCheckboxItemProps) {
  return (
    <BaseMenu.CheckboxItem
      {...props}
      className={cn(popup.item, popup.indicatorItem, className)}
    >
      <BaseMenu.CheckboxItemIndicator className={popup.indicator}>
        <Icon icon="check" size="md" />
      </BaseMenu.CheckboxItemIndicator>
      {children}
    </BaseMenu.CheckboxItem>
  );
}

export type MenuRadioItemProps = WithClassName<BaseMenu.RadioItem.Props>;

export function MenuRadioItem({
  children,
  className,
  ...props
}: MenuRadioItemProps) {
  return (
    <BaseMenu.RadioItem
      {...props}
      className={cn(popup.item, popup.indicatorItem, className)}
    >
      <BaseMenu.RadioItemIndicator className={popup.indicator}>
        <span className={styles.radioDot} />
      </BaseMenu.RadioItemIndicator>
      {children}
    </BaseMenu.RadioItem>
  );
}

export type MenuSubmenuTriggerProps =
  WithClassName<BaseMenu.SubmenuTrigger.Props>;

export function MenuSubmenuTrigger({
  children,
  className,
  ...props
}: MenuSubmenuTriggerProps) {
  return (
    <BaseMenu.SubmenuTrigger
      {...props}
      className={cn(popup.item, styles.submenuTrigger, className)}
    >
      {children}
      <Icon icon="chevron_right" size="md" className={styles.submenuChevron} />
    </BaseMenu.SubmenuTrigger>
  );
}

export type MenuGroupProps = BaseMenu.Group.Props;

export const MenuGroup = BaseMenu.Group;

export type MenuGroupLabelProps = WithClassName<BaseMenu.GroupLabel.Props>;

export function MenuGroupLabel({ className, ...props }: MenuGroupLabelProps) {
  return (
    <BaseMenu.GroupLabel
      {...props}
      className={cn(popup.groupLabel, className)}
    />
  );
}

export type MenuSeparatorProps = WithClassName<BaseMenu.Separator.Props>;

export function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return (
    <BaseMenu.Separator {...props} className={cn(popup.separator, className)} />
  );
}

export type MenuShortcutProps = ComponentProps<"kbd">;

export function MenuShortcut({ className, ...props }: MenuShortcutProps) {
  return <kbd {...props} className={cn(popup.shortcut, className)} />;
}

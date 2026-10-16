/** @jsxImportSource react */
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Icon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  type IconName,
} from "@lucent/ui-react";
import { useId, type ReactNode } from "react";

export interface RowControlProps {
  readonly "aria-describedby": string | undefined;
  readonly "aria-labelledby": string;
}

export function SettingsPane({
  children,
  description,
}: {
  readonly children: ReactNode;
  readonly description?: ReactNode;
}) {
  return (
    <div className="settings-pane">
      {description === undefined ? null : (
        <p className="settings-pane__description">{description}</p>
      )}
      {children}
    </div>
  );
}

export function SettingsGroup({
  action,
  children,
  className,
  title,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly title?: string;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={title === undefined ? undefined : titleId}
      className={
        className === undefined
          ? "settings-group"
          : `settings-group ${className}`
      }
    >
      {title === undefined && action === undefined ? null : (
        <header className="settings-group__header">
          {title === undefined ? null : (
            <h2 className="settings-group__title" id={titleId}>
              {title}
            </h2>
          )}
          {action}
        </header>
      )}
      <div className="settings-group__card">{children}</div>
    </section>
  );
}

export function SettingsRow({
  children,
  description,
  label,
}: {
  readonly children: (control: RowControlProps) => ReactNode;
  readonly description?: ReactNode;
  readonly label: ReactNode;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <span className="settings-row__label" id={labelId}>
          {label}
        </span>
        {description === undefined ? null : (
          <span className="settings-row__description" id={descriptionId}>
            {description}
          </span>
        )}
      </div>
      <div className="settings-row__control">
        {children({
          "aria-describedby":
            description === undefined ? undefined : descriptionId,
          "aria-labelledby": labelId,
        })}
      </div>
    </div>
  );
}

export function ActionIconButton({
  hidden = false,
  icon,
  label,
  onClick,
  tooltip,
}: {
  readonly hidden?: boolean;
  readonly icon: IconName;
  readonly label: string;
  readonly onClick: () => void;
  readonly tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="settings-icon-action"
            data-hidden={hidden ? "" : undefined}
            disabled={hidden}
            onClick={onClick}
            size="sm"
            square
            type="button"
            variant="ghost"
          >
            <Icon icon={icon} size="sm" />
          </Button>
        }
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function ResetAllButton({
  confirmLabel,
  description,
  onConfirm,
  title,
}: {
  readonly confirmLabel: string;
  readonly description: string;
  readonly onConfirm: () => void;
  readonly title: string;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button size="sm" type="button" />}>
        Reset all
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button size="sm" type="button" />}>
            Cancel
          </AlertDialogClose>
          <AlertDialogClose
            onClick={onConfirm}
            render={<Button size="sm" type="button" variant="danger" />}
          >
            {confirmLabel}
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

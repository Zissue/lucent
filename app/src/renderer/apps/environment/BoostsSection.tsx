/** @jsxImportSource react */
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  Label,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@lucent/ui-react";
import { useState } from "react";

import type { EnvironmentBankBoost } from "../../../shared/environmentBoosts";
import {
  environmentBoostWithdrawalSummary,
  prepareEnvironmentBankBoosts,
} from "./boosts";
import {
  AutomationSwitch,
  ClearButton,
  EntryForm,
  NameTag,
  RemoveButton,
  SheetSection,
  TagList,
  errorMessage,
  type EnvironmentSectionProps,
} from "./EnvironmentLayout";
import { splitEnvironmentBulkInput } from "./input";
import { renameEntry } from "./rename";

function BankBoostsDialog({
  boosts,
  onOpenChange,
  onWithdraw,
  open,
}: {
  readonly boosts: readonly EnvironmentBankBoost[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onWithdraw: (boosts: readonly EnvironmentBankBoost[]) => void;
  readonly open: boolean;
}) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  const toggle = (itemId: number, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
      return next;
    });
  };

  return (
    <AlertDialog
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          setSelected(new Set());
        }
      }}
      open={open}
    >
      <AlertDialogContent className="environment-bank-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Bank boosts</AlertDialogTitle>
          <AlertDialogDescription>
            Choose boosts to move to your inventory.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody className="environment-bank-dialog__body">
          <ul className="environment-bank-boosts">
            {boosts.map((boost) => (
              <li key={boost.itemId}>
                <Label className="environment-bank-boost">
                  <Checkbox
                    checked={selected.has(boost.itemId)}
                    onCheckedChange={(checked) => toggle(boost.itemId, checked)}
                  />
                  <span className="environment-bank-boost__name">
                    <span className="environment-bank-boost__quantity">
                      {boost.quantity.toLocaleString()}×
                    </span>
                    <span className="environment-bank-boost__label">
                      {boost.name}
                    </span>
                  </span>
                </Label>
              </li>
            ))}
          </ul>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button size="sm" type="button" />}>
            Cancel
          </AlertDialogClose>
          <Button
            disabled={selected.size === 0}
            onClick={() =>
              onWithdraw(boosts.filter((boost) => selected.has(boost.itemId)))
            }
            size="sm"
            type="button"
            variant="primary"
          >
            Withdraw selected
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function BoostsSection({
  environment,
  setError,
  state,
  update,
}: EnvironmentSectionProps) {
  const [fetching, setFetching] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [bankDialogOpen, setBankDialogOpen] = useState(false);
  const [bankBoosts, setBankBoosts] = useState<readonly EnvironmentBankBoost[]>(
    [],
  );

  const fetchBoosts = async (): Promise<void> => {
    setFetching(true);
    setError("");
    setBankDialogOpen(false);
    try {
      const discovery = await environment.fetchBoosts();
      const added =
        discovery.inventory.length > 0 &&
        (await update(() => environment.addBoosts(discovery.inventory))) !==
          null;
      const candidates = prepareEnvironmentBankBoosts(discovery.bank);
      if (candidates.length > 0) {
        setBankBoosts(candidates);
        setBankDialogOpen(true);
      }
      if (!discovery.bankLoaded) {
        setError(
          (current) =>
            current ||
            (added
              ? "Added inventory boosts. Couldn't search your bank."
              : "Couldn't search your bank."),
        );
      }
    } catch (cause) {
      console.error("Failed to fetch boosts:", cause);
      setError(errorMessage(cause, "Couldn't fetch boosts. Try again."));
    } finally {
      setFetching(false);
    }
  };

  const withdraw = async (
    selected: readonly EnvironmentBankBoost[],
  ): Promise<void> => {
    setBankDialogOpen(false);
    setWithdrawing(true);
    setError("");
    try {
      const selectedIds = new Set(selected.map((boost) => boost.itemId));
      const withdrawnIds = new Set(
        (
          await environment.withdrawBoosts(
            selected.map((boost) => boost.itemId),
          )
        ).filter((itemId) => selectedIds.has(itemId)),
      );
      const names = selected
        .filter((boost) => withdrawnIds.has(boost.itemId))
        .map((boost) => boost.name);
      if (names.length > 0) {
        await update(() => environment.addBoosts(names));
      }
      const summary = environmentBoostWithdrawalSummary(
        selected.length,
        withdrawnIds.size,
      );
      if (summary !== "") {
        setError((current) => (current ? `${current} ${summary}` : summary));
      }
    } catch (cause) {
      console.error("Failed to withdraw boosts:", cause);
      setError(errorMessage(cause, "Couldn't withdraw boosts. Try again."));
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <SheetSection
      actions={
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  className="environment-fetch-boosts"
                  disabled={fetching || withdrawing}
                  onClick={() => void fetchBoosts()}
                  size="sm"
                  variant="ghost"
                />
              }
            >
              {withdrawing ? "Withdrawing…" : fetching ? "Fetching…" : "Fetch"}
            </TooltipTrigger>
            <TooltipContent>
              Add boosts from your inventory and choose any from your bank
            </TooltipContent>
          </Tooltip>
          <ClearButton
            disabled={state.boosts.length === 0}
            label="boosts"
            onClick={() => void update(() => environment.clearBoosts())}
          />
          <AutomationSwitch
            checked={state.automation.boosts}
            label="boosts"
            onCheckedChange={(enabled) =>
              void update(() =>
                environment.setAutomationEnabled("boosts", enabled),
              )
            }
            tooltip="Use listed boosts"
          />
        </>
      }
      count={state.boosts.length}
      id="boosts"
      title="Boosts"
    >
      <EntryForm
        label="Add boost"
        onAdd={(value) => {
          const boosts = splitEnvironmentBulkInput(value);
          if (boosts.length > 0) {
            void update(() => environment.addBoosts(boosts));
          }
          return null;
        }}
        placeholder="Boost name; another boost"
      />
      <TagList
        count={state.boosts.length}
        emptyText="No boosts yet. Add names above, or use Fetch to find them in your inventory and bank."
      >
        {state.boosts.map((boost) => (
          <NameTag
            key={boost}
            name={boost}
            onRename={(next) =>
              void renameEntry(update, boost, next, {
                add: () => environment.addBoosts([next]),
                remove: () => environment.removeBoost(boost),
              })
            }
          >
            <RemoveButton
              label={`Remove ${boost}`}
              onClick={() => void update(() => environment.removeBoost(boost))}
            />
          </NameTag>
        ))}
      </TagList>
      <BankBoostsDialog
        boosts={bankBoosts}
        onOpenChange={setBankDialogOpen}
        onWithdraw={(selected) => void withdraw(selected)}
        open={bankDialogOpen}
      />
    </SheetSection>
  );
}

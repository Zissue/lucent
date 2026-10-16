import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";

export type InlineEditResult = "saved" | "invalid";

export function useInlineEdit({
  commit,
  initialValue,
}: {
  readonly commit: (value: string) => InlineEditResult;
  readonly initialValue: () => string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const finished = useRef(false);
  const restoreFocus = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editing = draft !== null;
  const focusOnMount = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
    input?.select();
  }, []);

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [editing]);

  const start = (): void => {
    finished.current = false;
    setInvalid(false);
    setDraft(initialValue());
  };

  const finish = (save: boolean, source: "blur" | "keyboard"): void => {
    if (finished.current || draft === null) {
      return;
    }
    if (save && commit(draft) === "invalid" && source === "keyboard") {
      setInvalid(true);
      return;
    }
    finished.current = true;
    restoreFocus.current = source === "keyboard";
    setDraft(null);
  };

  const inputProps: ComponentProps<"input"> = {
    "aria-invalid": invalid || undefined,
    onBlur: () => finish(true, "blur"),
    onChange: (event) => {
      setDraft(event.currentTarget.value);
      setInvalid(false);
    },
    onKeyDown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true, "keyboard");
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false, "keyboard");
      }
    },
    ref: focusOnMount,
    value: draft ?? "",
  };

  return {
    draft: draft ?? "",
    editing,
    inputProps,
    invalid,
    start,
    triggerRef,
  };
}

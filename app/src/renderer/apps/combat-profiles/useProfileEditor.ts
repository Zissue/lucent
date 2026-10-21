/** @jsxImportSource react */
import { toast } from "@lucent/ui-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_COMBAT_PROFILE_ID,
  duplicateCombatProfile,
  type CombatProfile,
  type CombatProfileLibrary,
} from "@lucent/core/combatProfiles";
import type { ProfileSummary } from "../../combatProfileOptions";
import {
  createBlankProfile,
  formatProfileSnippet,
  hasIncompleteRows,
  isUnsaved,
  nextProfileLabel,
  toSavableProfile,
  withClassNameEdit,
  withPendingClassName,
  type ClassNameEdit,
} from "./profileModel";
import {
  readStoredCombatProfileId,
  resolvePreferredCombatProfileId,
  writeStoredCombatProfileId,
} from "./profileSelection";

export interface CombatProfilesStore {
  readonly copyText: (text: string) => Promise<void>;
  readonly deleteProfile: (profileId: string) => Promise<CombatProfileLibrary>;
  readonly getState: () => Promise<CombatProfileLibrary>;
  readonly logError: (message: string, cause: unknown) => void;
  readonly onChanged: (
    listener: (library: CombatProfileLibrary) => void,
  ) => () => void;
  readonly saveProfile: (
    profile: CombatProfile,
  ) => Promise<CombatProfileLibrary>;
}

export type LeaveChoice = "discard" | "cancel";

export interface ProfileEditor {
  readonly classNameEdit: ClassNameEdit | undefined;
  readonly copySnippet: () => Promise<boolean>;
  readonly create: () => void;
  readonly creating: boolean;
  readonly dirty: boolean;
  readonly draft: CombatProfile | undefined;
  readonly duplicate: (profileId: string) => void;
  readonly finishClassNameEdit: (save: boolean) => void;
  /** Counts requests to edit the open profile's name; resets when a profile opens. */
  readonly focusNameRequest: number;
  /** Increments each time Save is blocked by a half-filled rule or trigger. */
  readonly invalidRequest: number;
  readonly isDefault: boolean;
  /** True while the unsaved-changes prompt is waiting for a choice. */
  readonly leaving: boolean;
  readonly loadFailed: boolean;
  readonly loaded: boolean;
  readonly pendingClassName: string;
  readonly profiles: readonly ProfileSummary[];
  readonly reload: () => Promise<void>;
  readonly remove: (profileId: string) => Promise<void>;
  readonly rename: (profileId: string) => void;
  readonly resolveLeave: (choice: LeaveChoice) => void;
  readonly revert: () => void;
  readonly save: () => Promise<boolean>;
  /** Why the last save failed; cleared by the next save attempt or a revert. */
  readonly saveError: string | undefined;
  readonly saving: boolean;
  readonly select: (profileId: string) => void;
  readonly selectedId: string;
  readonly setClassNameEdit: (edit: ClassNameEdit | undefined) => void;
  readonly setPendingClassName: (value: string) => void;
  readonly update: (recipe: (draft: CombatProfile) => CombatProfile) => void;
}

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const createProfileId = (): string => `profile-${crypto.randomUUID()}`;

const findProfile = (
  library: CombatProfileLibrary,
  profileId: string,
): CombatProfile | undefined =>
  library.profiles.find((profile) => profile.id === profileId);

const UNLOADED_LIBRARY: CombatProfileLibrary = { version: 1, profiles: [] };

export function useProfileEditor(store: CombatProfilesStore): ProfileEditor {
  const [library, setLibraryState] = useState(UNLOADED_LIBRARY);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState(
    () => readStoredCombatProfileId() ?? DEFAULT_COMBAT_PROFILE_ID,
  );
  const [draft, setDraftState] = useState<CombatProfile | undefined>(undefined);
  const [pendingClassName, setPendingClassNameState] = useState("");
  const [classNameEdit, setClassNameEditState] = useState<
    ClassNameEdit | undefined
  >(undefined);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [leaving, setLeaving] = useState(false);
  const [focusNameRequest, setFocusNameRequest] = useState(0);
  const [invalidRequest, setInvalidRequest] = useState(0);

  const draftRef = useRef(draft);
  const pendingClassNameRef = useRef(pendingClassName);
  const classNameEditRef = useRef(classNameEdit);
  const libraryRef = useRef(library);
  const savingRef = useRef(false);
  const creatingRef = useRef(false);
  const deletingIdRef = useRef<string | undefined>(undefined);
  const pendingLeave = useRef<(() => void) | undefined>(undefined);
  const storeQueue = useRef<Promise<unknown>>(Promise.resolve());

  const setDraft = useCallback((next: CombatProfile | undefined) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const setPendingClassName = useCallback((next: string) => {
    pendingClassNameRef.current = next;
    setPendingClassNameState(next);
  }, []);

  const setClassNameEdit = useCallback((next: ClassNameEdit | undefined) => {
    classNameEditRef.current = next;
    setClassNameEditState(next);
  }, []);

  const withPendingEdits = (current: CombatProfile): CombatProfile =>
    withPendingClassName(
      withClassNameEdit(current, classNameEditRef.current),
      pendingClassNameRef.current,
    );

  const setLibrary = useCallback((next: CombatProfileLibrary) => {
    libraryRef.current = next;
    setLibraryState(next);
  }, []);

  const enqueue = useCallback(<A>(task: () => Promise<A>): Promise<A> => {
    const run = storeQueue.current.then(task, task);
    storeQueue.current = run.catch(() => undefined);
    return run;
  }, []);

  const hydrate = useCallback(
    (profileId: string, next: CombatProfileLibrary) => {
      setFocusNameRequest(0);
      setInvalidRequest(0);
      setSaveError(undefined);
      setSelectedId(profileId);
      setDraft(findProfile(next, profileId));
      setPendingClassName("");
      setClassNameEdit(undefined);
    },
    [setClassNameEdit, setDraft, setPendingClassName],
  );

  const isDirty = (): boolean => {
    const current = draftRef.current;
    return (
      current !== undefined &&
      isUnsaved(
        withPendingEdits(current),
        findProfile(libraryRef.current, current.id),
      )
    );
  };

  const save = useCallback((): Promise<boolean> => {
    const edited = draftRef.current;
    if (
      edited === undefined ||
      savingRef.current ||
      edited.id === deletingIdRef.current
    ) {
      return Promise.resolve(false);
    }
    const pending = pendingClassNameRef.current;
    const edit = classNameEditRef.current;
    const current = withPendingClassName(
      withClassNameEdit(edited, edit),
      pending,
    );
    if (hasIncompleteRows(current)) {
      setSaveError(undefined);
      setInvalidRequest((request) => request + 1);
      return Promise.resolve(false);
    }
    const saved = findProfile(libraryRef.current, current.id);
    if (!isUnsaved(current, saved)) {
      return Promise.resolve(true);
    }

    savingRef.current = true;
    setSaving(true);
    setSaveError(undefined);
    return enqueue(() =>
      store.saveProfile(toSavableProfile(current, saved?.label ?? "Profile")),
    )
      .then(
        (next) => {
          setLibrary(next);
          if (
            draftRef.current === edited &&
            pendingClassNameRef.current === pending &&
            classNameEditRef.current === edit
          ) {
            setDraft(findProfile(next, current.id) ?? current);
            setPendingClassName("");
            setClassNameEdit(undefined);
          }
          return true;
        },
        (cause: unknown) => {
          store.logError("Failed to save combat profile", cause);
          setSaveError(errorMessage(cause, "Try again."));
          return false;
        },
      )
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  }, [
    enqueue,
    setClassNameEdit,
    setDraft,
    setLibrary,
    setPendingClassName,
    store,
  ]);

  const guard = (action: () => void): boolean => {
    if (isDirty()) {
      pendingLeave.current = action;
      setLeaving(true);
      return false;
    }
    action();
    return true;
  };

  const resolveLeave = useCallback((choice: LeaveChoice) => {
    const action = pendingLeave.current;
    pendingLeave.current = undefined;
    setLeaving(false);
    if (choice === "discard") {
      action?.();
    }
  }, []);

  const openProfile = (profileId: string) => {
    writeStoredCombatProfileId(profileId);
    hydrate(profileId, libraryRef.current);
  };

  const select = (profileId: string) => {
    if (profileId !== draftRef.current?.id) {
      guard(() => openProfile(profileId));
    }
  };

  const rename = (profileId: string) => {
    const focusName = () => setFocusNameRequest((request) => request + 1);
    if (profileId === draftRef.current?.id) {
      focusName();
    } else {
      guard(() => {
        openProfile(profileId);
        focusName();
      });
    }
  };

  const load = useCallback(
    () =>
      store
        .getState()
        .then((next) => {
          setLibrary(next);
          hydrate(
            resolvePreferredCombatProfileId(
              next.profiles,
              readStoredCombatProfileId(),
            ),
            next,
          );
          setLoadFailed(false);
          setLoaded(true);
        })
        .catch((cause: unknown) => {
          store.logError("Failed to load combat profiles", cause);
          setLoadFailed(true);
        }),
    [hydrate, setLibrary, store],
  );

  useEffect(() => {
    const unsubscribe = store.onChanged(setLibrary);

    void load();

    return unsubscribe;
    // The store is fixed for the window's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = useCallback(
    (recipe: (draft: CombatProfile) => CombatProfile) => {
      const current = draftRef.current;
      if (current !== undefined) {
        const next = recipe(current);
        setDraft(next);
        if (!hasIncompleteRows(next)) {
          setInvalidRequest(0);
        }
      }
    },
    [setDraft],
  );

  const finishClassNameEdit = useCallback(
    (save: boolean) => {
      const edit = classNameEditRef.current;
      if (edit === undefined) {
        return;
      }
      setClassNameEdit(undefined);
      if (save) {
        update((current) => withClassNameEdit(current, edit));
      }
    },
    [setClassNameEdit, update],
  );

  const revert = useCallback(() => {
    const current = draftRef.current;
    if (current === undefined || savingRef.current) {
      return;
    }
    setInvalidRequest(0);
    setSaveError(undefined);
    setDraft(findProfile(libraryRef.current, current.id) ?? current);
    setPendingClassName("");
    setClassNameEdit(undefined);
  }, [setClassNameEdit, setDraft, setPendingClassName]);

  const saveAndSelect = (profile: CombatProfile) => {
    const draftBefore = draftRef.current;
    const pendingClassNameBefore = pendingClassNameRef.current;
    const classNameEditBefore = classNameEditRef.current;
    creatingRef.current = true;
    setCreating(true);
    void enqueue(() => store.saveProfile(profile))
      .then((next) => {
        setLibrary(next);
        const open = () => {
          writeStoredCombatProfileId(profile.id);
          hydrate(profile.id, next);
          setFocusNameRequest((request) => request + 1);
        };
        if (
          draftRef.current === draftBefore &&
          pendingClassNameRef.current === pendingClassNameBefore &&
          classNameEditRef.current === classNameEditBefore
        ) {
          open();
        } else {
          guard(open);
        }
      })
      .catch((cause: unknown) => {
        store.logError("Failed to create combat profile", cause);
        toast.error("Couldn't create the profile", {
          description: errorMessage(cause, "Try again."),
        });
      })
      .finally(() => {
        creatingRef.current = false;
        setCreating(false);
      });
  };

  const create = () => {
    if (creatingRef.current) {
      return;
    }
    guard(() =>
      saveAndSelect(
        createBlankProfile(
          createProfileId(),
          nextProfileLabel(libraryRef.current.profiles),
        ),
      ),
    );
  };

  const duplicate = (profileId: string) => {
    if (creatingRef.current) {
      return;
    }
    const open = draftRef.current;
    if (open?.id === profileId) {
      const current = withPendingEdits(open);
      if (hasIncompleteRows(current)) {
        setSaveError(undefined);
        setInvalidRequest((request) => request + 1);
        return;
      }
      const saved = findProfile(libraryRef.current, profileId);
      saveAndSelect(
        duplicateCombatProfile(
          toSavableProfile(current, saved?.label ?? "Profile"),
          libraryRef.current.profiles,
          createProfileId,
        ),
      );
      return;
    }
    guard(() => {
      const saved = findProfile(libraryRef.current, profileId);
      if (saved !== undefined) {
        saveAndSelect(
          duplicateCombatProfile(
            saved,
            libraryRef.current.profiles,
            createProfileId,
          ),
        );
      }
    });
  };

  const remove = (profileId: string): Promise<void> => {
    if (profileId === DEFAULT_COMBAT_PROFILE_ID) {
      return Promise.resolve();
    }

    const profiles = libraryRef.current.profiles;
    const index = profiles.findIndex((profile) => profile.id === profileId);
    const neighbor = profiles[index + 1] ?? profiles[index - 1];

    deletingIdRef.current = profileId;
    return enqueue(() => store.deleteProfile(profileId))
      .then((next) => {
        setLibrary(next);
        if (draftRef.current?.id !== profileId) {
          return;
        }
        const fallback =
          neighbor !== undefined && findProfile(next, neighbor.id) !== undefined
            ? neighbor.id
            : resolvePreferredCombatProfileId(next.profiles, undefined);
        writeStoredCombatProfileId(fallback);
        hydrate(fallback, next);
      })
      .catch((cause: unknown) => {
        store.logError("Failed to delete combat profile", cause);
        throw cause;
      })
      .finally(() => {
        deletingIdRef.current = undefined;
      });
  };

  const copySnippet = (): Promise<boolean> => {
    const edited = draftRef.current;
    if (edited === undefined) {
      return Promise.resolve(false);
    }
    const current = withPendingEdits(edited);
    if (hasIncompleteRows(current)) {
      setInvalidRequest((request) => request + 1);
      return Promise.resolve(false);
    }
    const saved = findProfile(libraryRef.current, current.id);
    return store
      .copyText(
        formatProfileSnippet(
          toSavableProfile(current, saved?.label ?? "Profile"),
        ),
      )
      .then(
        () => true,
        (cause: unknown) => {
          store.logError("Failed to copy combat profile", cause);
          throw cause;
        },
      );
  };

  const draftId = draft?.id;
  const draftLabel = draft?.label;
  const draftClassNames = draft?.classNames;
  const profiles = useMemo(
    () =>
      library.profiles.map(
        (profile): ProfileSummary =>
          profile.id === draftId
            ? {
                id: profile.id,
                label: draftLabel?.trim() || profile.label,
                ...(draftClassNames === undefined
                  ? {}
                  : { classNames: draftClassNames }),
              }
            : profile,
      ),
    [draftClassNames, draftId, draftLabel, library],
  );

  return {
    classNameEdit,
    copySnippet,
    create,
    creating,
    dirty:
      draft !== undefined &&
      isUnsaved(
        withPendingClassName(
          withClassNameEdit(draft, classNameEdit),
          pendingClassName,
        ),
        findProfile(library, draft.id),
      ),
    draft,
    duplicate,
    finishClassNameEdit,
    focusNameRequest,
    invalidRequest,
    isDefault: draft?.id === DEFAULT_COMBAT_PROFILE_ID,
    leaving,
    loadFailed,
    loaded,
    pendingClassName,
    profiles,
    reload: load,
    remove,
    rename,
    resolveLeave,
    revert,
    save,
    saveError,
    saving,
    select,
    selectedId,
    setClassNameEdit,
    setPendingClassName,
    update,
  };
}

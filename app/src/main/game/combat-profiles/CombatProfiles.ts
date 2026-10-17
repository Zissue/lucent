import { join } from "node:path";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Schema from "effect/Schema";

import {
  DEFAULT_COMBAT_PROFILE_ID,
  DEFAULT_COMBAT_PROFILE_LIBRARY,
  cloneCombatProfileLibrary,
  normalizeCombatProfile,
  normalizeCombatProfileLibrary,
  serializeCombatProfileLibrary,
  type CombatProfile,
  type CombatProfileLibrary,
} from "@lucent/core/combatProfiles";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import {
  makeListenerRegistry,
  type Listener,
} from "../../app/ListenerRegistry";
import { FileSystem } from "effect/FileSystem";
import type * as Scope from "effect/Scope";
import { type JsonFileError, makeJsonFile } from "../../filesystem/JsonFile";

const combatProfilesOperationSchema = Schema.Literals([
  "delete-profile",
  "mkdir",
  "parse",
  "read",
  "rename",
  "save-profile",
  "unlink",
  "write",
]);

export class CombatProfilesError extends Schema.TaggedError<CombatProfilesError>()(
  "CombatProfilesError",
  {
    detail: Schema.String,
    operation: combatProfilesOperationSchema,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface CombatProfilesShape {
  readonly deleteProfile: (
    profileId: string,
  ) => Effect.Effect<CombatProfileLibrary, CombatProfilesError>;
  readonly get: Effect.Effect<CombatProfileLibrary, CombatProfilesError>;
  readonly load: Effect.Effect<CombatProfileLibrary, CombatProfilesError>;
  readonly onChanged: (
    listener: Listener<CombatProfileLibrary>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly saveProfile: (
    profile: CombatProfile,
  ) => Effect.Effect<CombatProfileLibrary, CombatProfilesError>;
}

export class CombatProfiles extends Context.Service<
  CombatProfiles,
  CombatProfilesShape
>()("lucent/desktop/game/combat-profiles/CombatProfiles") {}

const wrapDataError = (error: JsonFileError): CombatProfilesError =>
  new CombatProfilesError({
    operation: error.operation,
    detail: error.message,
    cause: error,
  });

const validationError = (
  operation: typeof combatProfilesOperationSchema.Type,
  detail: string,
): CombatProfilesError =>
  new CombatProfilesError({
    operation,
    detail,
  });

const defaultLibrary = (): CombatProfileLibrary =>
  cloneCombatProfileLibrary(DEFAULT_COMBAT_PROFILE_LIBRARY);

type IgnoredCombatProfileData = Partial<
  Record<
    | "profiles"
    | "steps"
    | "conditions"
    | "classNames"
    | "messageTriggers"
    | "fields",
    number
  >
>;

const isSavedRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isSavedArray = Schema.is(Schema.Array(Schema.Unknown));
const isSavedString = Schema.is(Schema.String);
const isSavedInteger = Schema.is(Schema.Int);

const inspectCombatProfiles = (
  source: Record<string, unknown>,
): IgnoredCombatProfileData => {
  const ignored: IgnoredCombatProfileData = {};
  const add = (kind: keyof IgnoredCombatProfileData) => {
    ignored[kind] = (ignored[kind] ?? 0) + 1;
  };
  const inspectFields = (
    raw: Record<string, unknown>,
    normalized: Readonly<Record<string, unknown>>,
    fields: readonly string[],
  ) => {
    for (const key of fields) {
      if (!Object.hasOwn(raw, key)) continue;
      const original = raw[key];
      const value = normalized[key];
      if (
        value === undefined &&
        ((["priority", "resetSkillIndexOnTargetDeath"].includes(key) &&
          original === false) ||
          (["waitMs", "cooldownMs"].includes(key) && original === 0))
      )
        continue;
      const comparable =
        ["id", "label", "consumable", "auraName", "messageIncludes"].includes(
          key,
        ) && isSavedString(original)
          ? original.trim()
          : original;
      if (comparable !== value) add("fields");
    }
  };
  const inspectEntries = <A>(
    raw: unknown,
    kind: keyof IgnoredCombatProfileData,
    normalize: (entry: unknown) => A | undefined,
    inspect: (entry: unknown, normalized: A) => void = () => {},
  ) => {
    if (raw === undefined) return;
    if (!isSavedArray(raw)) {
      add(kind);
      return;
    }
    for (const entry of raw) {
      const normalized = normalize(entry);
      if (normalized === undefined) add(kind);
      else inspect(entry, normalized);
    }
  };
  const version = source["version"];
  if (version !== undefined && (!isSavedInteger(version) || version < 0))
    add("fields");
  const ids = new Set<string>();
  inspectEntries(
    source["profiles"],
    "profiles",
    (raw) => {
      if (
        !isSavedRecord(raw) ||
        !isSavedString(raw["id"]) ||
        raw["id"].trim() === ""
      )
        return undefined;
      return normalizeCombatProfile(raw);
    },
    (raw, profile) => {
      if (!isSavedRecord(raw)) return;
      if (ids.has(profile.id)) add("fields");
      ids.add(profile.id);
      inspectFields(raw, profile, [
        "id",
        "label",
        "consumable",
        "delayMs",
        "cooldownMode",
        "resetSkillIndexOnTargetDeath",
      ]);
      inspectEntries(
        raw["classNames"],
        "classNames",
        (entry) =>
          normalizeCombatProfile({ id: "inspection", classNames: [entry] })
            .classNames?.[0],
        (entry, normalized) => {
          if (isSavedString(entry) && entry.trim() !== normalized)
            add("fields");
        },
      );
      inspectEntries(
        raw["messageTriggers"],
        "messageTriggers",
        (entry) =>
          normalizeCombatProfile({ id: "inspection", messageTriggers: [entry] })
            .messageTriggers?.[0],
        (entry, trigger) => {
          if (isSavedRecord(entry))
            inspectFields(entry, trigger, [
              "messageIncludes",
              "skill",
              "source",
              "cooldownMs",
            ]);
        },
      );
      inspectEntries(
        raw["steps"],
        "steps",
        (entry) =>
          normalizeCombatProfile({ id: "inspection", steps: [entry] }).steps[0],
        (entry, step) => {
          if (!isSavedRecord(entry)) return;
          inspectFields(entry, step, [
            "skill",
            "priority",
            "cooldownMode",
            "waitMs",
          ]);
          inspectEntries(
            entry["conditions"],
            "conditions",
            (condition) =>
              normalizeCombatProfile({
                id: "inspection",
                steps: [{ skill: 0, conditions: [condition] }],
              }).steps[0]?.conditions[0],
            (condition, normalized) => {
              if (isSavedRecord(condition))
                inspectFields(condition, normalized, [
                  "type",
                  "op",
                  "value",
                  "unit",
                  "auraName",
                ]);
            },
          );
        },
      );
    },
  );
  return ignored;
};

const saveProfileToLibrary = (
  current: CombatProfileLibrary,
  profile: CombatProfile,
): CombatProfileLibrary => {
  const normalizedProfile = normalizeCombatProfile(profile);
  const existingIndex = current.profiles.findIndex(
    (candidate) => candidate.id === normalizedProfile.id,
  );
  const profiles =
    existingIndex === -1
      ? [...current.profiles, normalizedProfile]
      : current.profiles.map((candidate, index) =>
          index === existingIndex ? normalizedProfile : candidate,
        );

  return normalizeCombatProfileLibrary({
    ...current,
    profiles,
  });
};

const deleteProfileFromLibrary = (
  current: CombatProfileLibrary,
  profileId: string,
): Effect.Effect<CombatProfileLibrary, CombatProfilesError> =>
  Effect.gen(function* () {
    if (profileId === DEFAULT_COMBAT_PROFILE_ID) {
      return yield* validationError(
        "delete-profile",
        "The generic combat profile cannot be deleted.",
      );
    }

    const profiles = current.profiles.filter(
      (profile) => profile.id !== profileId,
    );
    if (profiles.length === current.profiles.length) {
      return yield* validationError(
        "delete-profile",
        "Combat profile does not exist.",
      );
    }

    return normalizeCombatProfileLibrary({
      ...current,
      profiles,
    });
  });

const makeCombatProfiles = Effect.gen(function* () {
  const env = yield* DesktopEnvironment;
  const jsonFile = makeJsonFile(yield* FileSystem);
  const path = join(env.appDataDir, "combat-profiles.json");
  const libraryRef = yield* SynchronizedRef.make<{
    readonly value: CombatProfileLibrary | null;
    readonly publicationRevision: number;
  }>({ value: null, publicationRevision: 0 });
  const commitLock = yield* Semaphore.make(1);
  const libraryChanges = makeListenerRegistry<CombatProfileLibrary>();

  const readLibraryFromFile = Effect.fnUntraced(function* (
    diagnostics: boolean,
  ) {
    const unreadable = (error?: JsonFileError) =>
      diagnostics
        ? Effect.logWarning(
            "Saved combat profiles could not be read; using defaults until the next save",
            ...(error === undefined ? [] : [Cause.fail(error)]),
          ).pipe(
            Effect.annotateLogs({
              component: "combat-profiles",
              data: { path, ignored: { file: 1 } },
            }),
            Effect.map(defaultLibrary),
          )
        : Effect.succeed(defaultLibrary());
    const result = yield* jsonFile.read(path).pipe(
      Effect.catch((error) =>
        error.operation === "parse"
          ? Effect.succeed({ status: "invalid" as const, error })
          : Effect.fail(error),
      ),
      Effect.mapError(wrapDataError),
    );
    if (result.status === "invalid") return yield* unreadable(result.error);
    if (result.status === "missing") {
      const defaults = defaultLibrary();
      yield* jsonFile
        .write(path, serializeCombatProfileLibrary(defaults))
        .pipe(Effect.mapError(wrapDataError));
      return defaults;
    }

    if (!isSavedRecord(result.value)) return yield* unreadable();
    const library = yield* Effect.try({
      try: () => normalizeCombatProfileLibrary(result.value),
      catch: (cause) =>
        new CombatProfilesError({
          operation: "parse",
          detail:
            cause instanceof Error
              ? cause.message
              : "Invalid combat profile library.",
          cause,
        }),
    });
    if (
      result.value["profiles"] !== undefined &&
      !isSavedArray(result.value["profiles"])
    ) {
      return yield* unreadable();
    }
    const ignored = inspectCombatProfiles(result.value);
    if (Object.keys(ignored).length > 0) {
      if (diagnostics) {
        yield* Effect.logWarning(
          "Saved combat profiles had invalid entries; ignoring them until the next save",
        ).pipe(
          Effect.annotateLogs({
            component: "combat-profiles",
            data: { path, ignored },
          }),
        );
      }
      return library;
    }
    yield* jsonFile
      .write(path, serializeCombatProfileLibrary(library))
      .pipe(Effect.mapError(wrapDataError));
    return library;
  });

  const writeLibraryFile = (
    library: CombatProfileLibrary,
  ): Effect.Effect<CombatProfileLibrary, CombatProfilesError> => {
    const normalized = normalizeCombatProfileLibrary(library);
    return jsonFile
      .write(path, serializeCombatProfileLibrary(normalized))
      .pipe(Effect.mapError(wrapDataError), Effect.as(normalized));
  };

  const publishCurrent = SynchronizedRef.get(libraryRef).pipe(
    Effect.flatMap(({ value, publicationRevision }) =>
      value === null || publicationRevision === 0
        ? Effect.void
        : libraryChanges.publishLatest(publicationRevision, value),
    ),
  );
  const get = SynchronizedRef.modifyEffect(libraryRef, (current) =>
    (current.value === null
      ? readLibraryFromFile(true)
      : Effect.succeed(current.value)
    ).pipe(
      Effect.map(
        (library) => [library, { ...current, value: library }] as const,
      ),
    ),
  ).pipe(Effect.uninterruptible, Semaphore.withPermit(commitLock));
  const load = SynchronizedRef.modifyEffect(libraryRef, (current) =>
    readLibraryFromFile(true).pipe(
      Effect.map(
        (library) =>
          [
            library,
            {
              value: library,
              publicationRevision: current.publicationRevision + 1,
            },
          ] as const,
      ),
    ),
  ).pipe(
    Effect.uninterruptible,
    Semaphore.withPermit(commitLock),
    Effect.ensuring(publishCurrent),
  );
  const update = (
    modify: (
      current: CombatProfileLibrary,
    ) => Effect.Effect<CombatProfileLibrary, CombatProfilesError>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      SynchronizedRef.modifyEffect(libraryRef, (current) =>
        (current.value === null
          ? readLibraryFromFile(false)
          : Effect.succeed(current.value)
        ).pipe(
          Effect.flatMap((value) => restore(modify(value))),
          Effect.flatMap(writeLibraryFile),
          Effect.map(
            (saved) =>
              [
                saved,
                {
                  value: saved,
                  publicationRevision: current.publicationRevision + 1,
                },
              ] as const,
          ),
        ),
      ),
    ).pipe(Semaphore.withPermit(commitLock), Effect.ensuring(publishCurrent));

  const deleteProfile: CombatProfilesShape["deleteProfile"] = (profileId) =>
    update((current) => deleteProfileFromLibrary(current, profileId));

  const onChanged: CombatProfilesShape["onChanged"] = libraryChanges.subscribe;

  const saveProfile: CombatProfilesShape["saveProfile"] = (profile) =>
    update((current) => Effect.succeed(saveProfileToLibrary(current, profile)));

  return CombatProfiles.of({
    deleteProfile,
    get,
    load,
    onChanged,
    saveProfile,
  });
});

export const layer = Layer.effect(CombatProfiles, makeCombatProfiles);

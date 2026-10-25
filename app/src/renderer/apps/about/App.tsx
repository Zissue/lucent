import { Button, Icon } from "@lucent/ui";
import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";

import { selectDesktopBridge } from "../../../shared/desktopBridge";
import type { AboutFolder, AboutInfo, AboutLink } from "../../../shared/ipc";
import type { UpdateCheckState } from "../../../shared/updates";

const COPIED_RESET_MS = 2_000;

const FOLDERS: readonly { readonly id: AboutFolder; readonly label: string }[] =
  [
    { id: "appData", label: "App data" },
    { id: "logs", label: "Logs" },
    { id: "scripts", label: "Scripts" },
  ];

const LINKS: readonly { readonly id: AboutLink; readonly label: string }[] = [
  { id: "documentation", label: "Docs" },
  { id: "repository", label: "GitHub" },
  { id: "releaseNotes", label: "Release notes" },
  { id: "issues", label: "Report an issue" },
];

const formatCommit = (build: AboutInfo["build"]): string | null =>
  build.commit === null
    ? null
    : build.dirty
      ? `${build.commit}-dirty`
      : build.commit;

const formatBuiltAt = (builtAt: string | null): string =>
  builtAt === null
    ? "Unknown"
    : new Date(builtAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });

const formatChannel = (channel: AboutInfo["channel"]): string =>
  channel === "development" ? "Development" : "Release";

const formatSystem = (system: AboutInfo["system"]): string =>
  `${system.platform} ${system.osVersion} (${system.arch})`;

export const formatDiagnostics = (info: AboutInfo): string => {
  const commit = formatCommit(info.build);
  return [
    `Lucent ${info.version}${commit === null ? "" : ` (${commit})`}`,
    `Channel: ${formatChannel(info.channel)}`,
    `Built: ${info.build.builtAt ?? "Unknown"}`,
    `OS: ${formatSystem(info.system)}`,
  ].join("\n");
};

const updateStatusText = (state: UpdateCheckState): string => {
  switch (state.status) {
    case "idle":
      return "Not checked yet";
    case "disabled":
      return "Automatic checks are off";
    case "checking":
      return "Checking for updates…";
    case "current":
      return "Up to date";
    case "available":
      return `Version ${state.latestVersion} is available`;
    case "error":
      return state.message;
  }
};

export type AboutInfoState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly info: AboutInfo }
  | { readonly status: "failed" };

export interface AboutViewProps {
  readonly infoState: AboutInfoState;
  readonly updateState: UpdateCheckState | null;
  readonly onCheckForUpdates: () => Promise<unknown>;
  readonly onCopyText: (text: string) => Promise<void>;
  readonly onOpenFolder: (folder: AboutFolder) => Promise<boolean>;
  readonly onOpenLink: (link: AboutLink) => Promise<boolean>;
  readonly onOpenReleasePage: () => Promise<boolean>;
}

function InfoRow(props: {
  readonly children: JSX.Element;
  readonly label: string;
}): JSX.Element {
  return (
    <>
      <dt class="about-info__label">{props.label}</dt>
      <dd class="about-info__value">{props.children}</dd>
    </>
  );
}

export function AboutView(props: AboutViewProps): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => clearTimeout(copiedTimer));

  const reportFailure = (message: string) => (cause: unknown) => {
    console.error(message, cause);
    setNotice(message);
  };

  const open = (request: () => Promise<boolean>, failure: string): void => {
    setNotice(null);
    void request()
      .then((opened) => {
        if (!opened) setNotice(failure);
      })
      .catch(reportFailure(failure));
  };

  const openFolder = (folder: AboutFolder, label: string): void =>
    open(
      () => props.onOpenFolder(folder),
      `Couldn't open the ${label} folder.`,
    );

  const openLink = (link: AboutLink): void =>
    open(
      () => props.onOpenLink(link),
      "Couldn't open the link in your browser.",
    );

  const copyDiagnostics = (info: AboutInfo): void => {
    setNotice(null);
    void props
      .onCopyText(formatDiagnostics(info))
      .then(() => {
        setCopied(true);
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
      })
      .catch(reportFailure("Couldn't copy to the clipboard."));
  };

  const checkForUpdates = (): void => {
    setNotice(null);
    setChecking(true);
    void props
      .onCheckForUpdates()
      .catch(reportFailure("Couldn't check for updates."))
      .finally(() => setChecking(false));
  };

  const updateAvailable = () => props.updateState?.status === "available";
  const statusText = () =>
    notice() ??
    (props.updateState === null ? "" : updateStatusText(props.updateState));
  const statusTone = () =>
    notice() !== null ? "error" : updateAvailable() ? "available" : undefined;

  return (
    <main class="about-app">
      <Show when={props.infoState.status === "failed"}>
        <p class="about-header__status" data-tone="error" role="status">
          Couldn't load app details. Reopen this window to try again.
        </p>
      </Show>
      <Show
        when={props.infoState.status === "loaded" ? props.infoState.info : null}
      >
        {(info) => (
          <>
            <header class="about-header">
              <div class="about-header__text">
                <h1 class="about-header__title">
                  Lucent{" "}
                  <span class="about-header__version">
                    {info().version}
                    <Show when={info().channel === "development"}> (dev)</Show>
                  </span>
                </h1>
                <p
                  class="about-header__status"
                  data-tone={statusTone()}
                  role="status"
                  title={statusText()}
                >
                  {statusText()}
                </p>
              </div>
              <Show
                fallback={
                  <Button
                    disabled={
                      checking() || props.updateState?.status === "checking"
                    }
                    onClick={checkForUpdates}
                    size="xs"
                    type="button"
                    variant="secondary"
                  >
                    Check for updates
                  </Button>
                }
                when={updateAvailable()}
              >
                <Button
                  onClick={() =>
                    open(
                      () => props.onOpenReleasePage(),
                      "Couldn't open the release page.",
                    )
                  }
                  size="xs"
                  type="button"
                >
                  View release
                  <Icon icon="arrow_up_right" size="xs" />
                </Button>
              </Show>
            </header>

            <section
              aria-labelledby="about-details-title"
              class="about-section"
            >
              <div class="about-section__header">
                <h2 class="about-section__title" id="about-details-title">
                  Details
                </h2>
                <Button
                  onClick={() => copyDiagnostics(info())}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  <Icon icon={copied() ? "check" : "copy"} size="xs" />
                  {copied() ? "Copied" : "Copy diagnostics"}
                </Button>
              </div>
              <dl class="about-info">
                <InfoRow label="Commit">
                  <Show fallback="Unknown" when={formatCommit(info().build)}>
                    {(commit) => (
                      <button
                        class="about-info__link about-info__mono"
                        onClick={() => openLink("commit")}
                        title="View this commit on GitHub"
                        type="button"
                      >
                        {commit()}
                      </button>
                    )}
                  </Show>
                </InfoRow>
                <InfoRow label="Built">
                  {formatBuiltAt(info().build.builtAt)}
                </InfoRow>
                <InfoRow label="Channel">
                  {formatChannel(info().channel)}
                </InfoRow>
                <InfoRow label="System">{formatSystem(info().system)}</InfoRow>
              </dl>
            </section>

            <div aria-label="Open folder" class="about-actions" role="group">
              <For each={FOLDERS}>
                {(folder) => (
                  <Button
                    onClick={() =>
                      openFolder(folder.id, folder.label.toLowerCase())
                    }
                    size="xs"
                    title={info().paths[folder.id]}
                    type="button"
                    variant="secondary"
                  >
                    <Icon icon="folder_open" size="xs" />
                    {folder.label}
                  </Button>
                )}
              </For>
            </div>

            <nav aria-label="Links" class="about-links">
              <For each={LINKS}>
                {(link) => (
                  <button
                    class="about-links__item"
                    onClick={() => openLink(link.id)}
                    type="button"
                  >
                    {link.label}
                  </button>
                )}
              </For>
            </nav>
          </>
        )}
      </Show>
    </main>
  );
}

export function App(): JSX.Element {
  const desktop = selectDesktopBridge(window.desktop, "about");
  const [infoState, setInfoState] = createSignal<AboutInfoState>({
    status: "loading",
  });
  const [updateState, setUpdateState] = createSignal<UpdateCheckState | null>(
    null,
  );

  onMount(() => {
    const unsubscribe = desktop.updates.onChanged(setUpdateState);
    onCleanup(unsubscribe);

    void Promise.all([desktop.about.getInfo(), desktop.updates.getState()])
      .then(([nextInfo, nextUpdateState]) => {
        setInfoState({ status: "loaded", info: nextInfo });
        setUpdateState((current) => current ?? nextUpdateState);
      })
      .catch((cause: unknown) => {
        console.error("Failed to load About details:", cause);
        setInfoState({ status: "failed" });
      })
      .finally(() => {
        document.documentElement.dataset["ready"] = "true";
      });
  });

  return (
    <AboutView
      infoState={infoState()}
      onCheckForUpdates={() =>
        desktop.updates.checkNow().then((state) => setUpdateState(state))
      }
      onCopyText={(text) => navigator.clipboard.writeText(text)}
      onOpenFolder={(folder) => desktop.about.openFolder(folder)}
      onOpenLink={(link) => desktop.about.openLink(link)}
      onOpenReleasePage={() => desktop.updates.openReleasePage()}
      updateState={updateState()}
    />
  );
}

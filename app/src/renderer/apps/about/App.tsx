/** @jsxImportSource react */
import {
  Button,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@lucent/ui-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

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

function InfoRow({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <>
      <dt className="about-info__label">{label}</dt>
      <dd className="about-info__value">{children}</dd>
    </>
  );
}

export function AboutView({
  infoState,
  updateState,
  onCheckForUpdates,
  onCopyText,
  onOpenFolder,
  onOpenLink,
  onOpenReleasePage,
}: AboutViewProps) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

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
    open(() => onOpenFolder(folder), `Couldn't open the ${label} folder.`);

  const openLink = (link: AboutLink): void =>
    open(() => onOpenLink(link), "Couldn't open the link in your browser.");

  const copyDiagnostics = (info: AboutInfo): void => {
    setNotice(null);
    void onCopyText(formatDiagnostics(info))
      .then(() => {
        setCopied(true);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(
          () => setCopied(false),
          COPIED_RESET_MS,
        );
      })
      .catch(reportFailure("Couldn't copy to the clipboard."));
  };

  const checkForUpdates = (): void => {
    setNotice(null);
    setChecking(true);
    void onCheckForUpdates()
      .catch(reportFailure("Couldn't check for updates."))
      .finally(() => setChecking(false));
  };

  const updateAvailable = updateState?.status === "available";
  const statusText =
    notice ?? (updateState === null ? "" : updateStatusText(updateState));
  const statusTone =
    notice !== null ? "error" : updateAvailable ? "available" : undefined;
  const info = infoState.status === "loaded" ? infoState.info : null;
  const commit = info === null ? null : formatCommit(info.build);

  return (
    <main className="about-app">
      {infoState.status === "failed" ? (
        <p className="about-header__status" data-tone="error" role="status">
          Couldn't load app details. Reopen this window to try again.
        </p>
      ) : null}
      {info === null ? null : (
        <>
          <header className="about-header">
            <div className="about-header__text">
              <h1 className="about-header__title">
                Lucent{" "}
                <span className="about-header__version">
                  {info.version}
                  {info.channel === "development" ? " (dev)" : null}
                </span>
              </h1>
              <p
                className="about-header__status"
                data-tone={statusTone}
                role="status"
                title={statusText}
              >
                {statusText}
              </p>
            </div>
            {updateAvailable ? (
              <Button
                onClick={() =>
                  open(onOpenReleasePage, "Couldn't open the release page.")
                }
                size="sm"
                type="button"
                variant="primary"
              >
                View release
                <Icon icon="arrow_up_right" size="sm" />
              </Button>
            ) : (
              <Button
                disabled={checking || updateState?.status === "checking"}
                onClick={checkForUpdates}
                size="sm"
                type="button"
                variant="secondary"
              >
                Check for updates
              </Button>
            )}
          </header>

          <section
            aria-labelledby="about-details-title"
            className="about-section"
          >
            <div className="about-section__header">
              <h2 className="about-section__title" id="about-details-title">
                Details
              </h2>
              <div className="about-section__actions">
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        className="about-section__folders"
                        size="sm"
                        type="button"
                        variant="ghost"
                      />
                    }
                  >
                    <Icon icon="folder_open" size="sm" />
                    Open folder
                    <Icon icon="chevron_down" size="sm" />
                  </MenuTrigger>
                  <MenuContent align="end" className="about-folders">
                    {FOLDERS.map((folder) => (
                      <MenuItem
                        className="about-folders__item"
                        key={folder.id}
                        title={info.paths[folder.id]}
                        onClick={() =>
                          openFolder(folder.id, folder.label.toLowerCase())
                        }
                      >
                        {folder.label}
                      </MenuItem>
                    ))}
                  </MenuContent>
                </Menu>
                <Button
                  onClick={() => copyDiagnostics(info)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Icon icon={copied ? "check" : "copy"} size="sm" />
                  Copy diagnostics
                </Button>
                <span
                  aria-atomic="true"
                  className="about-visually-hidden"
                  role="status"
                >
                  {copied ? "Copied diagnostics to the clipboard" : ""}
                </span>
              </div>
            </div>
            <dl className="about-info">
              <InfoRow label="Commit">
                {commit === null ? (
                  "Unknown"
                ) : (
                  <button
                    className="about-info__link about-info__mono"
                    onClick={() => openLink("commit")}
                    title="View this commit on GitHub"
                    type="button"
                  >
                    {commit}
                  </button>
                )}
              </InfoRow>
              <InfoRow label="Built">
                {formatBuiltAt(info.build.builtAt)}
              </InfoRow>
              <InfoRow label="Channel">{formatChannel(info.channel)}</InfoRow>
              <InfoRow label="System">{formatSystem(info.system)}</InfoRow>
            </dl>
          </section>

          <nav aria-label="Links" className="about-links">
            {LINKS.map((link) => (
              <button
                className="about-links__item"
                key={link.id}
                onClick={() => openLink(link.id)}
                type="button"
              >
                {link.label}
              </button>
            ))}
          </nav>
        </>
      )}
    </main>
  );
}

export function App() {
  const desktop = selectDesktopBridge(window.desktop, "about");
  const [infoState, setInfoState] = useState<AboutInfoState>({
    status: "loading",
  });
  const [updateState, setUpdateState] = useState<UpdateCheckState | null>(null);

  useEffect(() => {
    const unsubscribe = desktop.updates.onChanged(setUpdateState);

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

    return unsubscribe;
  }, [desktop]);

  return (
    <AboutView
      infoState={infoState}
      onCheckForUpdates={() =>
        desktop.updates.checkNow().then((state) => setUpdateState(state))
      }
      onCopyText={(text) => navigator.clipboard.writeText(text)}
      onOpenFolder={(folder) => desktop.about.openFolder(folder)}
      onOpenLink={(link) => desktop.about.openLink(link)}
      onOpenReleasePage={() => desktop.updates.openReleasePage()}
      updateState={updateState}
    />
  );
}

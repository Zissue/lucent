/** @jsxImportSource react */
import { Toaster, TooltipProvider } from "@lucent/ui-react";
import { useMemo } from "react";

import { selectDesktopBridge } from "../../../shared/desktopBridge";
import { BehaviorRows, Group, InvalidRequestContext } from "./controls";
import { ProfilesLayout } from "./ProfilesLayout";
import { RotationSection } from "./RotationSection";
import { TriggersSection } from "./TriggersSection";
import { useProfileEditor, type CombatProfilesStore } from "./useProfileEditor";

export function App() {
  const store = useMemo((): CombatProfilesStore => {
    const { combatProfiles, log } = selectDesktopBridge(
      window.desktop,
      "combat-profiles",
    );
    return {
      copyText: (text) => navigator.clipboard.writeText(text),
      deleteProfile: (profileId) => combatProfiles.deleteProfile(profileId),
      getState: () => combatProfiles.getState(),
      logError: (message, cause) => log.error(message, cause),
      onChanged: (listener) => combatProfiles.onChanged(listener),
      saveProfile: (profile) => combatProfiles.saveProfile(profile),
    };
  }, []);
  const editor = useProfileEditor(store);

  return (
    <TooltipProvider>
      <InvalidRequestContext value={editor.invalidRequest}>
        <ProfilesLayout editor={editor}>
          {(draft) => (
            <>
              <RotationSection draft={draft} update={editor.update} />
              <TriggersSection draft={draft} update={editor.update} />
              <Group title="Details">
                <BehaviorRows draft={draft} onChange={editor.update} />
              </Group>
            </>
          )}
        </ProfilesLayout>
      </InvalidRequestContext>
      <Toaster />
    </TooltipProvider>
  );
}

import { StackActions, useNavigation } from "@react-navigation/native";

import { openSettings } from "../settings/settings-navigation";
import { VoicePanel } from "./VoicePanel";

/** Voice on layouts without a thread inspector. */
export function VoiceSheet() {
  const navigation = useNavigation();
  return (
    <VoicePanel
      presentation="sheet"
      onClose={() => navigation.goBack()}
      onOpenThread={(target) => navigation.dispatch(StackActions.replace("Thread", target))}
      onOpenSettings={() => openSettings(navigation, "SettingsVoice")}
    />
  );
}

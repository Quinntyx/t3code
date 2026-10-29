import { DEFAULT_UNIFIED_SETTINGS, type Buddy } from "@t3tools/contracts/settings";
import { BanIcon } from "lucide-react";
import { Suspense, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { BuddyIdlePreview } from "../buddy/BuddyIdlePreview";
import { BUDDY_CHARACTERS, type BuddyCharacterId } from "../buddy/buddyCharacters";
import { SettingResetButton, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const PREVIEW_HEIGHT_PX = 96;

export function BuddySection() {
  const buddy = useScopedSettings().buddy;
  const updateSettings = useUpdateScopedSettings();
  const select = (next: Buddy) => updateSettings({ buddy: next });

  return (
    <SettingsSection
      id="appearance-buddy"
      title="Buddy"
      headerAction={
        buddy !== DEFAULT_UNIFIED_SETTINGS.buddy ? (
          <SettingResetButton
            label="buddy"
            onClick={() => select(DEFAULT_UNIFIED_SETTINGS.buddy)}
          />
        ) : null
      }
    >
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          A companion that reacts to the agent in the open thread. Drag it anywhere on screen.
        </p>
        <div
          id={searchableSetting("buddy").id}
          className="grid w-full gap-2"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 12rem), 1fr))" }}
        >
          <BuddyCard
            label="None"
            description="No companion"
            isActive={buddy === "none"}
            onSelect={() => select("none")}
            preview={<BanIcon className="size-10 text-muted-foreground" strokeWidth={1.5} />}
          />
          {(Object.keys(BUDDY_CHARACTERS) as BuddyCharacterId[]).map((id) => {
            const character = BUDDY_CHARACTERS[id];
            return (
              <BuddyCard
                key={id}
                label={character.label}
                description={character.description}
                isActive={buddy === id}
                onSelect={() => select(id)}
                preview={
                  <Suspense fallback={null}>
                    <BuddyIdlePreview character={character} height={PREVIEW_HEIGHT_PX} />
                  </Suspense>
                }
              />
            );
          })}
        </div>
      </div>
    </SettingsSection>
  );
}

function BuddyCard({
  label,
  description,
  isActive,
  onSelect,
  preview,
}: {
  label: string;
  description: string;
  isActive: boolean;
  onSelect: () => void;
  preview: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={isActive}
      aria-label={`Use ${label} buddy${isActive ? ", currently active" : ""}`}
      className={cn(
        "cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card/60 text-left outline-none transition-colors hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        isActive && "bg-accent/30",
      )}
      style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
      onClick={onSelect}
    >
      <div
        className="flex items-center justify-center pt-3"
        style={{ height: PREVIEW_HEIGHT_PX + 12 }}
      >
        {preview}
      </div>
      <div className="px-3 pb-3 pt-2">
        <div className="truncate text-sm font-medium text-foreground">{label}</div>
        <div className="truncate text-xs text-muted-foreground">{description}</div>
      </div>
    </button>
  );
}

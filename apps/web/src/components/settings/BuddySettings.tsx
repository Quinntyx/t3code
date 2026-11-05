import { DEFAULT_UNIFIED_SETTINGS, type Buddy } from "@t3tools/contracts/settings";
import { BanIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Suspense, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { BuddyIdlePreview } from "../buddy/BuddyIdlePreview";
import {
  BUDDY_CHARACTERS,
  BUDDY_CHARACTER_IDS,
  type BuddyCharacter,
} from "../buddy/buddyCharacters";
import { useBuddyCatalog } from "../buddy/buddySources";
import { SettingResetButton, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const PREVIEW_HEIGHT_PX = 96;

export function BuddySection() {
  const settings = useScopedSettings();
  const buddy = settings.buddy;
  const updateSettings = useUpdateScopedSettings();
  const select = (next: Buddy) => updateSettings({ buddy: next });
  const repositoryUrls = settings.buddySources.map((source) => source.repositoryUrl);
  const catalog = useBuddyCatalog(repositoryUrls);

  const setSources = (urls: ReadonlyArray<string>) =>
    updateSettings({ buddySources: urls.map((repositoryUrl) => ({ repositoryUrl })) });

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
          {BUDDY_CHARACTER_IDS.map((id) => {
            const character = BUDDY_CHARACTERS[id];
            if (character === undefined) return null;
            return (
              <BuddyChoice
                key={id}
                reference={id}
                character={character}
                isActive={buddy === id}
                onSelect={select}
              />
            );
          })}
          {[...catalog.characters].map(([reference, character]) => (
            <BuddyChoice
              key={reference}
              reference={reference}
              character={character}
              isActive={buddy === reference}
              onSelect={select}
            />
          ))}
        </div>
        <BuddySources repositoryUrls={repositoryUrls} onChange={setSources} catalog={catalog} />
      </div>
    </SettingsSection>
  );
}

function BuddyChoice({
  reference,
  character,
  isActive,
  onSelect,
}: {
  reference: string;
  character: BuddyCharacter;
  isActive: boolean;
  onSelect: (next: Buddy) => void;
}) {
  return (
    <BuddyCard
      label={character.label}
      description={character.description}
      isActive={isActive}
      onSelect={() => onSelect(reference)}
      preview={
        <Suspense fallback={null}>
          <BuddyIdlePreview character={character} height={PREVIEW_HEIGHT_PX} />
        </Suspense>
      }
    />
  );
}

function BuddySources({
  repositoryUrls,
  onChange,
  catalog,
}: {
  repositoryUrls: ReadonlyArray<string>;
  onChange: (urls: ReadonlyArray<string>) => void;
  catalog: ReturnType<typeof useBuddyCatalog>;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const url = draft.trim();
    if (url.length === 0 || repositoryUrls.includes(url)) return;
    onChange([...repositoryUrls, url]);
    setDraft("");
  };

  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-card/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">Buddy sources</div>
          <div className="text-xs text-muted-foreground">
            Git repositories laid out with one folder per buddy. Cloned with your existing
            connections and re-pulled on load.
          </div>
        </div>
        <button
          type="button"
          aria-label="Reload buddy sources"
          className="cursor-pointer rounded-md p-1.5 text-muted-foreground outline-none hover:bg-accent/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={catalog.refresh}
        >
          <RefreshCwIcon className={cn("size-4", catalog.loading && "animate-spin")} />
        </button>
      </div>
      <div className="flex gap-2">
        <input
          aria-label="Buddy source repository URL"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          placeholder="https://git.example.com/you/buddy-arts.git"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <button
          type="button"
          aria-label="Add buddy source"
          className="cursor-pointer rounded-md border border-border px-2 py-1.5 text-muted-foreground outline-none hover:bg-accent/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={add}
        >
          <PlusIcon className="size-4" />
        </button>
      </div>
      {repositoryUrls.length === 0 ? (
        <p className="text-xs text-muted-foreground">No sources yet.</p>
      ) : (
        <ul className="space-y-1">
          {catalog.sources.map((source) => (
            <li
              key={source.repositoryUrl}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-foreground">
                {source.repositoryUrl}
                <span className="ml-2 text-muted-foreground">
                  {source.error ??
                    `${source.buddies.length} ${source.buddies.length === 1 ? "buddy" : "buddies"}`}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Remove buddy source ${source.repositoryUrl}`}
                className="cursor-pointer rounded p-1 text-muted-foreground outline-none hover:bg-destructive/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() =>
                  onChange(repositoryUrls.filter((url) => url !== source.repositoryUrl))
                }
              >
                <Trash2Icon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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

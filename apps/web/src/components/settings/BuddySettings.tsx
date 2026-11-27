import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type Buddy } from "@t3tools/contracts/settings";
import { T, useGT } from "gt-react";
import { BanIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Suspense, useState, type ReactNode } from "react";

import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useEnvironmentScope } from "~/state/session";

import { BuddyIdlePreview } from "../buddy/BuddyIdlePreview";
import {
  BUDDY_CHARACTERS,
  BUDDY_CHARACTER_IDS,
  type BuddyCharacter,
} from "../buddy/buddyCharacters";
import { useBuddyCatalog, useBuddyEnvironment } from "../buddy/buddySources";
import { SettingResetButton, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const PREVIEW_HEIGHT_PX = 96;

export function BuddySection() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const buddy = settings.buddy;
  const updateClientSettings = useUpdateScopedSettings();
  const environment = useBuddyEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const hasSettingsWriteScope = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canEditFolders = environmentId !== null && hasSettingsWriteScope;
  const updateEnvironmentSettings = useUpdateEnvironmentSettings(environmentId);
  const select = (next: Buddy) => updateClientSettings({ buddy: next });
  const folderPaths = environment?.serverConfig?.settings.buddyFolders ?? [];
  const catalog = useBuddyCatalog(environmentId, folderPaths);

  const setFolders = (nextFolders: ReadonlyArray<string>) => {
    if (!canEditFolders) return;
    updateEnvironmentSettings({ buddyFolders: [...nextFolders] });
    if (
      buddy !== "none" &&
      !Object.hasOwn(BUDDY_CHARACTERS, buddy) &&
      !nextFolders.some((folderPath) => buddy.startsWith(`${folderPath}|`))
    ) {
      select("none");
    }
  };

  return (
    <SettingsSection
      id="appearance-buddy"
      title={gt("Buddy")}
      headerAction={
        buddy !== DEFAULT_UNIFIED_SETTINGS.buddy ? (
          <SettingResetButton
            ariaLabel={gt("Reset buddy to default")}
            onClick={() => select(DEFAULT_UNIFIED_SETTINGS.buddy)}
          />
        ) : null
      }
    >
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          <T>
            A companion that reacts to the agent in the open thread. Drag it anywhere on screen.
          </T>
        </p>
        <div
          id={searchableSetting("buddy").id}
          className="grid w-full gap-2"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 12rem), 1fr))" }}
        >
          <BuddyCard
            label={gt("None")}
            description={gt("No companion")}
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
        <BuddyFolders
          folderPaths={folderPaths}
          canEdit={canEditFolders}
          onChange={setFolders}
          catalog={catalog}
        />
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

function BuddyFolders({
  folderPaths,
  canEdit,
  onChange,
  catalog,
}: {
  folderPaths: ReadonlyArray<string>;
  canEdit: boolean;
  onChange: (folders: ReadonlyArray<string>) => void;
  catalog: ReturnType<typeof useBuddyCatalog>;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState("");
  const add = () => {
    const folder = draft.trim();
    if (!canEdit || folder.length === 0 || folderPaths.includes(folder)) return;
    onChange([...folderPaths, folder]);
    setDraft("");
  };

  const catalogByPath = new Map(catalog.folders.map((entry) => [entry.folderPath, entry]));

  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-card/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">
            <T>Buddy folders</T>
          </div>
          <div className="text-xs text-muted-foreground">
            <T>
              Folders on disk holding buddy art. Point to a buddy folder with buddy.json, or a
              parent folder with one subfolder per buddy.
            </T>
          </div>
        </div>
        <button
          type="button"
          aria-label={gt("Reload buddy folders")}
          disabled={folderPaths.length === 0}
          className="cursor-pointer rounded-md p-1.5 text-muted-foreground outline-none hover:bg-accent/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          onClick={catalog.refresh}
        >
          <RefreshCwIcon className={cn("size-4", catalog.loading && "animate-spin")} />
        </button>
      </div>
      <div className="flex gap-2">
        <input
          aria-label={gt("Buddy folder path")}
          disabled={!canEdit}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="~/buddies"
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
          aria-label={gt("Add buddy folder")}
          disabled={!canEdit || draft.trim().length === 0}
          className="cursor-pointer rounded-md border border-border px-2 py-1.5 text-muted-foreground outline-none hover:bg-accent/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          onClick={add}
        >
          <PlusIcon className="size-4" />
        </button>
      </div>
      {folderPaths.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>No folders yet.</T>
        </p>
      ) : (
        <ul className="space-y-1">
          {folderPaths.map((folderPath) => {
            const entry = catalogByPath.get(folderPath);
            return (
              <li key={folderPath} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {folderPath}
                  {entry ? (
                    <span className="ml-2 text-muted-foreground">
                      {entry.error ??
                        gt("{count, plural, one {{count} buddy} other {{count} buddies}}", {
                          count: entry.buddies.length,
                        })}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  aria-label={gt("Remove buddy folder {path}", { path: folderPath })}
                  disabled={!canEdit}
                  className="cursor-pointer rounded p-1 text-muted-foreground outline-none hover:bg-destructive/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => onChange(folderPaths.filter((path) => path !== folderPath))}
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </li>
            );
          })}
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
  const gt = useGT();
  return (
    <button
      type="button"
      aria-pressed={isActive}
      aria-label={
        isActive
          ? gt("Use {label} buddy, currently active", { label })
          : gt("Use {label} buddy", { label })
      }
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

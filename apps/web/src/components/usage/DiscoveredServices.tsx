import { useAtomValue } from "@effect/atom-react";
import {
  discoverServiceProviderEnvironment,
  discoverServiceSupportsDriver,
  mergeProviderInstanceEnvironment,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { DiscoverServiceCredential, DiscoverServiceEntry } from "@t3tools/contracts/discover";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { BoxesIcon, KeyRoundIcon, LinkIcon, UnlinkIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { directoryDiscovery } from "../../state/discover";
import { environmentPresentations } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DiscoveryList, DiscoveryListRow } from "../ui/discovery-list";
import { toastManager } from "../ui/toast";

const healthLabel = (service: DiscoverServiceEntry) =>
  service.health === "online" ? "Online" : service.health === "offline" ? "Offline" : "Unknown";

const endpointLabel = (service: DiscoverServiceEntry) => {
  const endpoint = service.endpoints[0];
  if (endpoint === undefined) return "No endpoint";
  try {
    return `${endpoint.transport} · ${new URL(endpoint.httpBaseUrl).host}`;
  } catch {
    return endpoint.transport;
  }
};

const capabilityLabel = (service: DiscoverServiceEntry) =>
  service.capabilities.includes("key-exchange") ? "Issues keys" : "Bring your own key";

const maskedKey = (apiKey: string) =>
  apiKey.length <= 10 ? apiKey : `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;

/** One environment's compatible provider instances, with its own settings subscription. */
function EnvironmentTargets({
  environmentId,
  environmentLabel,
  service,
  credential,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly service: DiscoverServiceEntry;
  readonly credential: DiscoverServiceCredential;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const persist = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const [selected, setSelected] = useState<ReadonlySet<ProviderInstanceId>>(() => new Set());
  const [pending, setPending] = useState(false);
  const compatible = Object.entries(settings.providerInstances).filter(([, instance]) =>
    discoverServiceSupportsDriver(instance.driver, credential.protocol),
  );
  if (compatible.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {environmentLabel} has no provider that accepts this service.
      </p>
    );
  }
  const toggle = (instanceId: ProviderInstanceId, next: boolean) =>
    setSelected((current) => {
      const updated = new Set(current);
      if (next) updated.add(instanceId);
      else updated.delete(instanceId);
      return updated;
    });
  const apply = async () => {
    if (pending || selected.size === 0) return;
    setPending(true);
    let applied = 0;
    for (const instanceId of selected) {
      const instance = settings.providerInstances[instanceId];
      if (instance === undefined) continue;
      const additions = discoverServiceProviderEnvironment({
        driver: instance.driver,
        serviceId: service.serviceId,
        credential,
      });
      if (additions === null) continue;
      const result = await persist({
        operation: "upsert",
        instanceId,
        instance: {
          ...instance,
          environment: mergeProviderInstanceEnvironment(instance.environment, additions),
        },
      });
      if (result._tag === "Success") applied += 1;
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not configure a provider",
          description: failure instanceof Error ? failure.message : undefined,
        });
      }
    }
    setPending(false);
    if (applied > 0) {
      toastManager.add({
        type: "success",
        title: `Configured ${applied} provider${applied === 1 ? "" : "s"}`,
        description: `${environmentLabel} now reaches ${service.label}.`,
      });
      setSelected(new Set());
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-muted-foreground">
          {environmentLabel}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={pending || selected.size === 0}
          onClick={() => void apply()}
        >
          {pending ? "Applying…" : `Apply to ${selected.size || "selected"}`}
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        {compatible.map(([instanceId, instance]) => (
          <label
            key={instanceId}
            className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-accent/40"
          >
            <Checkbox
              checked={selected.has(instanceId as ProviderInstanceId)}
              onCheckedChange={(checked) =>
                toggle(instanceId as ProviderInstanceId, checked === true)
              }
            />
            <span className="truncate">{instance.displayName ?? instanceId}</span>
            <span className="ms-auto shrink-0 text-xs text-muted-foreground">
              {instance.driver}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function LinkServiceDialog({
  service,
  initialCredential,
  onClose,
}: {
  readonly service: DiscoverServiceEntry;
  readonly initialCredential: DiscoverServiceCredential | null;
  readonly onClose: () => void;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const link = useAtomCommand(directoryDiscovery.linkService, { reportFailure: false });
  const unlink = useAtomCommand(directoryDiscovery.unlinkService, { reportFailure: false });
  const [credential, setCredential] = useState<DiscoverServiceCredential | null>(initialCredential);
  const [linkedWithoutCredential, setLinkedWithoutCredential] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linked = service.linkedAt !== null || credential !== null || linkedWithoutCredential;
  const issuesCredential = service.capabilities.includes("key-exchange");

  const load = async () => {
    const result = await link({ serviceId: service.serviceId });
    if (result._tag === "Success") {
      setCredential(result.value.credential);
      return result.value;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not link this service.");
    }
    return null;
  };

  const environments = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null,
    )
    .map(([environmentId, presentation]) => ({
      environmentId,
      label: presentation.serverConfig?.environment.label ?? environmentId,
    }));

  const runLink = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await load();
    setPending(false);
    // A service without key exchange links successfully with no credential to show.
    if (result !== null && result.credential === null) setLinkedWithoutCredential(true);
  };

  const runUnlink = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await unlink(service.serviceId);
    setPending(false);
    if (result._tag === "Success") {
      setCredential(null);
      setLinkedWithoutCredential(false);
      toastManager.add({ type: "success", title: `${service.label} unlinked` });
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not unlink this service.");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{service.label}</DialogTitle>
          <DialogDescription>
            {service.kind} · {endpointLabel(service)} · {healthLabel(service)} ·{" "}
            {capabilityLabel(service)}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
            {credential === null ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  {linked
                    ? issuesCredential
                      ? "The credential issued for this machine could not be loaded."
                      : "This service is linked. It does not issue a credential through discovery."
                    : issuesCredential
                      ? "Linking asks the discovery server to mint a credential for this machine. Nothing is shared until you link."
                      : "Linking records this service on this machine. It does not issue a credential."}
                </p>
                {linked && !issuesCredential ? null : (
                  <Button disabled={pending} onClick={() => void runLink()}>
                    <LinkIcon aria-hidden />
                    {pending ? "Linking…" : linked ? "Retry" : "Link service"}
                  </Button>
                )}
                {linked ? (
                  <Button variant="outline" disabled={pending} onClick={() => void runUnlink()}>
                    <UnlinkIcon aria-hidden />
                    Unlink and revoke
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1 rounded-lg border border-border/70 p-3">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <KeyRoundIcon className="size-3.5" aria-hidden />
                    Credential for this machine
                  </span>
                  <code className="truncate font-mono text-xs text-foreground">
                    {maskedKey(credential.apiKey)}
                  </code>
                  <span className="truncate text-xs text-muted-foreground">
                    {credential.protocol} · {credential.baseUrl}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium text-foreground">Apply to providers</span>
                  <p className="text-xs text-muted-foreground">
                    Sets the base URL and credential on the providers you pick. Existing values for
                    those names are replaced.
                  </p>
                  {environments.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Connect an environment to configure its providers.
                    </p>
                  ) : (
                    environments.map((environment) => (
                      <EnvironmentTargets
                        key={environment.environmentId}
                        environmentId={environment.environmentId}
                        environmentLabel={environment.label}
                        service={service}
                        credential={credential}
                      />
                    ))
                  )}
                </div>
                <Button variant="outline" disabled={pending} onClick={() => void runUnlink()}>
                  <UnlinkIcon aria-hidden />
                  Unlink and revoke
                </Button>
              </div>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function DiscoveredServicesSection() {
  const state = useAtomValue(directoryDiscovery.stateValueAtom);
  const readLink = useAtomCommand(directoryDiscovery.serviceLink, { reportFailure: false });
  const openSequence = useRef(0);
  const [open, setOpen] = useState<{
    readonly serviceId: string;
    readonly credential: DiscoverServiceCredential | null;
  } | null>(null);
  if (state.services.length === 0) return null;
  const selected = state.services.find((service) => service.serviceId === open?.serviceId) ?? null;
  // Opening reads the stored credential; it must never mint one, because a stale listing would
  // otherwise turn a click into a link. A late response for a newer click is dropped.
  const openService = async (service: DiscoverServiceEntry) => {
    const sequence = ++openSequence.current;
    if (service.linkedAt === null) {
      setOpen({ serviceId: service.serviceId, credential: null });
      return;
    }
    const result = await readLink(service.serviceId);
    if (sequence !== openSequence.current) return;
    setOpen({
      serviceId: service.serviceId,
      credential: result._tag === "Success" ? (result.value?.credential ?? null) : null,
    });
  };
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Discovered services</h2>
      <DiscoveryList>
        {state.services.map((service) => (
          <DiscoveryListRow
            key={service.serviceId}
            icon={<BoxesIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
            title={service.label}
            description={`${service.kind} · ${endpointLabel(service)} · ${healthLabel(service)}`}
            action={
              <span className="shrink-0 text-xs text-muted-foreground">
                {service.linkedAt === null ? "Not linked" : "Linked"}
              </span>
            }
            onClick={() => void openService(service)}
          />
        ))}
      </DiscoveryList>
      {selected === null ? null : (
        <LinkServiceDialog
          key={selected.serviceId}
          service={selected}
          initialCredential={open?.credential ?? null}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

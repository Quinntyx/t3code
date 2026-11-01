import { useAtomValue } from "@effect/atom-react";
import { pipe } from "effect/Function";
import {
  EMAIL_REQUEST_NO_PERMISSION_NOTE,
  EMAIL_REQUEST_PRIVACY_NOTE,
  emailComposerEdits,
  emailRequestAnswerInput,
  emailRequestDisplay,
  emailRequestFailureMessage,
  type EmailComposerFields,
  type EmailRequestItem,
} from "@t3tools/client-runtime/email-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const MAIL_SYMBOL: AppSymbolName = { ios: "envelope", android: "mail" };

export function EmailRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "email_request") return null;
  const display = emailRequestDisplay(item, visibility);
  if (display.kind === "pending") {
    return <PendingEmailComposer environmentId={props.environmentId} item={item} />;
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere"
      ? MAIL_SYMBOL
      : display.outcome === "sent"
        ? "checkmark"
        : "minus";
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {display.label}
      </Text>
    </View>
  );
}

function Field(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="font-sans text-xs text-foreground-muted">{props.label}</Text>
      {props.children}
    </View>
  );
}

function PendingEmailComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly item: EmailRequestItem;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerEmailRequest, {
    label: "answer email request",
  });
  const [fields, setFields] = useState<EmailComposerFields>(() => emailComposerEdits.get(item));
  const [showCopies, setShowCopies] = useState(
    item.draft.cc.length > 0 || item.draft.bcc.length > 0,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const canAnswer = useAtomValue(
    serverEnvironment.answerEmailRequest.permissionAtom(props.environmentId),
  );
  const locked = submitting || !canAnswer;
  const canSend = emailRequestAnswerInput(item, { type: "send", fields }) !== null;
  const update = (field: keyof EmailComposerFields) => (value: string) => {
    const next = { ...fields, [field]: value };
    emailComposerEdits.set(item, next);
    setFields(next);
  };

  const send = async (
    reply:
      | { readonly type: "send"; readonly fields: EmailComposerFields }
      | { readonly type: "discard" },
  ) => {
    const input = emailRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") return emailComposerEdits.clear(item);
    if (isAtomCommandInterrupted(result)) return;
    pipe(squashAtomCommandFailure(result), emailRequestFailureMessage, setError);
  };

  const addressInput = (field: "to" | "cc" | "bcc", label: string) => (
    <TextInput
      accessibilityLabel={label}
      value={fields[field]}
      onChangeText={update(field)}
      editable={!locked}
      autoCorrect={false}
      autoCapitalize="none"
      keyboardType="email-address"
      // Wraps so every recipient stays visible for review.
      multiline
      submitBehavior="blurAndSubmit"
      placeholder={field === "to" ? "name@example.com" : undefined}
    />
  );

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row items-center gap-2">
        <SymbolView
          name={MAIL_SYMBOL}
          size={15}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <Text className="font-t3-bold text-base text-foreground">Email draft</Text>
      </View>
      <Field label="From">
        <View className="flex-row flex-wrap gap-2">
          {item.accounts.map((account) => {
            const selected = account.name === fields.account;
            return (
              <Pressable
                key={account.name}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: locked }}
                disabled={locked}
                onPress={() => update("account")(account.name)}
                className={cn(
                  "max-w-full rounded-full border px-3 py-1.5 active:opacity-70",
                  selected ? "border-foreground bg-foreground/10" : "border-border",
                )}
              >
                <Text
                  numberOfLines={1}
                  className={cn(
                    "font-sans text-sm",
                    selected ? "text-foreground" : "text-foreground-muted",
                  )}
                >
                  {account.from}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Field>
      <Field label="To">{addressInput("to", "To")}</Field>
      {showCopies ? (
        <>
          <Field label="Cc">{addressInput("cc", "Cc")}</Field>
          <Field label="Bcc">{addressInput("bcc", "Bcc")}</Field>
        </>
      ) : (
        <View className="flex-row">
          <Button label="Add Cc or Bcc" tone="text" onPress={() => setShowCopies(true)} />
        </View>
      )}
      <Field label="Subject">
        <TextInput
          accessibilityLabel="Subject"
          value={fields.subject}
          onChangeText={update("subject")}
          editable={!locked}
        />
      </Field>
      <Field label="Message">
        <TextInput
          accessibilityLabel="Message"
          className="min-h-40"
          multiline
          textAlignVertical="top"
          value={fields.body}
          onChangeText={update("body")}
          editable={!locked}
        />
      </Field>
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <Button
        label={submitting ? "Sending…" : "Send"}
        tone="primary"
        fullWidth
        disabled={locked || !canSend}
        onPress={() => void send({ type: "send", fields })}
      />
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 font-sans text-xs text-foreground-muted">
          {canAnswer ? EMAIL_REQUEST_PRIVACY_NOTE : EMAIL_REQUEST_NO_PERMISSION_NOTE}
        </Text>
        <Button
          label="Discard"
          tone="text"
          disabled={locked}
          onPress={() => void send({ type: "discard" })}
        />
      </View>
    </View>
  );
}

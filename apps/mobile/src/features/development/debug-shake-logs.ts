const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
type LogConsole = Pick<Console, (typeof LEVELS)[number]>;

function formatArgument(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

export function captureConsoleTail(target: LogConsole = console) {
  const lines: string[] = [];
  const restore = LEVELS.map((level) => {
    const original = target[level];
    const wrapped = (...args: unknown[]) => {
      original.apply(target, args);
      const text = args.map(formatArgument).join(" ");
      for (const line of text.split(/\r?\n/).slice(-200)) {
        lines.push(`[${level}] ${line}`.slice(0, 2_000));
      }
      if (lines.length > 200) lines.splice(0, lines.length - 200);
    };
    target[level] = wrapped;
    return () => {
      if (target[level] === wrapped) target[level] = original;
    };
  });
  return {
    read: () => lines.join("\n"),
    dispose: () => restore.forEach((dispose) => dispose()),
  };
}

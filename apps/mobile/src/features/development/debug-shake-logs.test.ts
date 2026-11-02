import { expect, it, vi } from "vite-plus/test";

import { captureConsoleTail } from "./debug-shake-logs";

it("keeps the last 200 physical lines without swallowing console output, then restores it", () => {
  const output = vi.fn();
  const target = { log: output, info: output, warn: output, error: output, debug: output };
  const capture = captureConsoleTail(target);
  for (let line = 0; line < 205; line++) target.log(`line ${line}`);
  const error = new Error("broken");
  error.stack = "Error: broken";
  target.error(error, { detail: "context" });
  const lines = capture.read().split("\n");
  expect(lines).toHaveLength(200);
  expect(lines[0]).toContain("line 6");
  expect(lines.at(-1)).toContain('broken {"detail":"context"}');
  expect(output).toHaveBeenCalledTimes(206);
  target.warn("first\nsecond");
  expect(capture.read().split("\n").slice(-2)).toEqual(["[warn] first", "[warn] second"]);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  target.debug(circular, "x".repeat(5_000));
  expect(capture.read().split("\n").at(-1)!.length).toBeLessThanOrEqual(2_000);
  const retained = capture.read();
  capture.dispose();
  expect(target.log).toBe(output);
  target.log("after disabling");
  expect(capture.read()).toBe(retained);
});

it("does not overwrite a later console owner during teardown", () => {
  const output = vi.fn();
  const target = { log: output, info: output, warn: output, error: output, debug: output };
  const capture = captureConsoleTail(target);
  const replacement = vi.fn();
  target.warn = replacement;
  capture.dispose();
  expect(target.warn).toBe(replacement);
});

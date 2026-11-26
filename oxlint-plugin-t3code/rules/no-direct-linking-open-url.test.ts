import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-direct-linking-open-url", {
  filename: "apps/mobile/src/features/settings/providers/Example.tsx",
});

describe("t3code/no-direct-linking-open-url", () => {
  rule.valid(
    "allows the guarded helper",
    `
      import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";

      void tryOpenExternalUrl("https://example.com");
    `,
  );

  rule.valid(
    "allows other Linking methods",
    `
      import { Linking } from "react-native";

      void Linking.canOpenURL("https://example.com");
    `,
  );

  rule.invalid(
    "reports Linking.openURL calls",
    `
      import { Linking } from "react-native";

      void Linking.openURL("https://example.com");
    `,
  );

  rule.invalid(
    "reports openURL destructured from react-native",
    `import { openURL } from "react-native";`,
  );
});

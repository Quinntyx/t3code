import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const MESSAGE =
  "Open external URLs with tryOpenExternalUrl from apps/mobile/src/lib/openExternalUrl.ts; a direct Linking.openURL rejects and leaves the failure unreported.";

const isLinking = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    Option.isSome(expression) &&
    expression.value.type === "Identifier" &&
    expression.value.name === "Linking"
  );
};

const isOpenUrl = (node: unknown): boolean => {
  const name = getPropertyName(node);
  return Option.isSome(name) && name.value === "openURL";
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct Linking.openURL calls in mobile code; use tryOpenExternalUrl so a failed open is reported instead of rejecting.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        if (!isLinking(node.callee.object) || !isOpenUrl(node.callee.property)) return;
        context.report({ node: node.callee, message: MESSAGE });
      },
      ImportDeclaration(node) {
        if (node.source.value !== "react-native") return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          if (imported === "openURL") context.report({ node: specifier, message: MESSAGE });
        }
      },
    };
  },
});

import { describe, expect, it } from "vite-plus/test";
import { markdownForNativeParsing } from "./markdownDocument";

const jacobian = String.raw`\frac{\partial(x,y)}{\partial(u,v)}
=
\det
\begin{pmatrix}
x_u&x_v\\
y_u&y_v
\end{pmatrix}`;

const singleLineJacobian = String.raw`\frac{\partial(x,y)}{\partial(u,v)} = \det \begin{pmatrix} x_u&x_v\\ y_u&y_v \end{pmatrix}`;

describe("display math for the native parser", () => {
  it.each([
    {
      name: "the change-of-variables formula",
      source: `In your change-of-variables notation,\n\\[\n${jacobian}\n\\]\nmeans a **determinant**, hence a single number.`,
      expected: `In your change-of-variables notation,\n\\[${singleLineJacobian}\\]\nmeans a **determinant**, hence a single number.`,
    },
    {
      name: "dollar delimiters",
      source: "$$\na\n=\nb\n$$",
      expected: "$$a = b$$",
    },
    {
      name: "a blockquote",
      source: "> text\n> \\[\n> a\n> =\n> b\n> \\]",
      expected: "> text\n> \\[a = b\\]",
    },
    {
      name: "a list item",
      source: "- text\n  \\[\n  a\n  =\n  b\n  \\]",
      expected: "- text\n  \\[a = b\\]",
    },
    {
      name: "TeX comments",
      source: "\\[\n\\text{a% comment\nb} + 1% another comment\n= 2\n\\]",
      expected: "\\[\\text{ab} + 1= 2\\]",
    },
    {
      name: "comments after TeX commands",
      source: "\\[\n\\alpha% comment\nb + x \\quad% gap\ny\n\\]",
      expected: "\\[\\alpha b + x \\quad y\\]",
    },
    {
      name: "escaped percentages and matrix rows",
      source: "\\[\n\\begin{matrix}50\\%\\\\% row comment\n25\\%\\end{matrix}\n\\]",
      expected: "\\[\\begin{matrix}50\\%\\\\25\\%\\end{matrix}\\]",
    },
    {
      name: "CRLF line endings",
      source: "\\[\r\na\r\n=\r\nb\r\n\\]",
      expected: "\\[a = b\\]",
    },
  ])("keeps $name out of Markdown block rules", ({ source, expected }) => {
    expect(markdownForNativeParsing(source)).toBe(expected);
  });

  it("leaves code, inline math, incomplete math, and actual headings alone", () => {
    for (const source of [
      "```md\n\\[\na\n=\nb\n\\]\n```",
      "```math\na\n=\nb\n```",
      "`$$a = b$$`",
      "Inline \\(a = b\\) and $a = b$.",
      "\\[\na\n=\nb",
      "Heading\n===",
      "\\[a = b\\]",
    ]) {
      expect(markdownForNativeParsing(source)).toBe(source);
    }
  });
});

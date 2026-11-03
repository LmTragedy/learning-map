import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import type { Options } from "react-markdown";
import "katex/dist/katex.min.css";

type Pluggable = NonNullable<Options["remarkPlugins"]>[number];

/** Plugins that turn `$…$` and `$$…$$` into typeset formulas; a formula KaTeX cannot parse is shown as its source. */
export const remarkMathPlugin: Pluggable = [remarkMath, { singleDollarTextMath: true }];
export const rehypeKatexPlugin: Pluggable = [rehypeKatex, { throwOnError: false, strict: "ignore" }];

// Fenced blocks and inline code keep their text exactly as written.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;

/**
 * Models often write LaTeX as `\( … \)` and `\[ … \]`. Markdown reads `\(` and `\[` as escaped
 * punctuation and drops the backslash, so the formula shows as plain brackets. Rewrite those
 * delimiters to the dollar forms remark-math understands, leaving code untouched.
 */
export function normalizeMath(text: string): string {
  return text.split(CODE).map((part, index) => index % 2 ? part : part
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`)).join("");
}

type MdNode = { type: string; value?: string; children?: MdNode[] };
const LEFTOVER_STRONG = /\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g;

/**
 * CommonMark will not close `**` after full-width punctuation when a CJK character follows, so
 * `**关系（relation）**就是` stays literal. Text that still holds a `**…**` pair after parsing becomes bold.
 */
function cjkStrong() {
  const visit = (node: MdNode) => {
    if (!node.children || node.type === "code" || node.type === "inlineCode") return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== "text" || !child.value?.includes("**")) { visit(child); return [child]; }
      const parts: MdNode[] = [];
      let last = 0;
      for (const match of child.value.matchAll(LEFTOVER_STRONG)) {
        if (match.index! > last) parts.push({ type: "text", value: child.value.slice(last, match.index) });
        parts.push({ type: "strong", children: [{ type: "text", value: match[1] }] });
        last = match.index! + match[0].length;
      }
      if (!parts.length) return [child];
      if (last < child.value.length) parts.push({ type: "text", value: child.value.slice(last) });
      return parts;
    });
  };
  return (tree: MdNode) => visit(tree);
}
export const remarkCjkStrongPlugin: Pluggable = cjkStrong;

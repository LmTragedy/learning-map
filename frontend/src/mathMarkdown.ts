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

/**
 * Text direction for mixed Persian/Arabic/Hebrew and English chat. A block takes the direction of its first strong character
 * (like the Unicode bidi algorithm's paragraph rule); text with no letters at all is left-to-right.
 */
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
const LTR_CHAR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

export function dirOf(text: string): "rtl" | "ltr" {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return "rtl";
    if (LTR_CHAR.test(ch)) return "ltr";
  }
  return "ltr";
}

type HNode = { type?: string; value?: string; children?: HNode[] };

/** Plain text of a markdown (hast) node. */
export const textOf = (n: HNode | undefined): string => (!n ? "" : n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));

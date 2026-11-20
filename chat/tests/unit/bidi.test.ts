import { describe, expect, it } from "vitest";
import { dirOf, textOf } from "@/lib/bidi";

describe("dirOf (first strong character decides)", () => {
  it("Persian, Arabic and Hebrew are right-to-left; English is left-to-right", () => {
    expect(dirOf("مدل چیست؟")).toBe("rtl");
    expect(dirOf("مرحبا بالعالم")).toBe("rtl");
    expect(dirOf("שלום עולם")).toBe("rtl");
    expect(dirOf("What is the model?")).toBe("ltr");
  });
  it("skips leading digits, punctuation, markup and emoji", () => {
    expect(dirOf("1. شکارچی")).toBe("rtl");
    expect(dirOf("۱. شکارچی")).toBe("rtl");
    expect(dirOf("✅ (123) سلام")).toBe("rtl");
    expect(dirOf("- 42: hello")).toBe("ltr");
  });
  it("a mixed block follows whichever script comes first, not whichever appears at all", () => {
    expect(dirOf("NetLogo مدل جدید")).toBe("ltr");
    expect(dirOf("مدل NetLogo جدید")).toBe("rtl");
    expect(dirOf("/Users/me/Downloads: پوشه")).toBe("ltr");
  });
  it("empty or letter-free text is left-to-right", () => {
    expect(dirOf("")).toBe("ltr");
    expect(dirOf("123 --- !!!")).toBe("ltr");
  });
});

describe("textOf (markdown node text)", () => {
  it("joins nested text and ignores structure", () => {
    const node = { type: "element", children: [{ type: "text", value: "سلام " }, { type: "element", children: [{ type: "text", value: "world" }] }] };
    expect(textOf(node)).toBe("سلام world");
    expect(textOf(undefined)).toBe("");
  });
  it("a list whose items start with Persian is rtl even when an item contains English later", () => {
    const list = { type: "element", children: [{ type: "element", children: [{ type: "text", value: "گوسفندان (sheep)" }] }, { type: "element", children: [{ type: "text", value: "wolves" }] }] };
    expect(dirOf(textOf(list))).toBe("rtl");
  });
});

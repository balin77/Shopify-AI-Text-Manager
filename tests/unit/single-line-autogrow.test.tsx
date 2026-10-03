/**
 * Single-line values in auto-growing boxes (SingleLineTextField,
 * AutoGrowTextarea): the box wraps, the VALUE never gains a line break — a
 * handle, an SEO title or a title with "\n" in it is a broken URL or a broken
 * `<title>`. And the navigation's InfoBox fit rule, which keeps the strip at
 * one height.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import {
  hasLineBreak,
  isLineBreakKey,
  normalizeSingleLineChange,
  toSingleLine,
} from "~/utils/single-line-text";
import {
  INFO_BOX_BORDER_PX,
  INFO_BOX_COMPACT,
  INFO_BOX_PADDING_Y,
  INFO_BOX_STRIP_HEIGHT,
  infoBoxFitMode,
} from "~/utils/info-box-fit";
import { SingleLineTextField } from "~/components/unified/SingleLineTextField";
import { AutoGrowTextarea } from "~/components/unified/AutoGrowTextarea";

afterEach(cleanup);

describe("toSingleLine", () => {
  it("leaves a value without line breaks untouched", () => {
    expect(toSingleLine("Kumiko Box – Walnut")).toBe("Kumiko Box – Walnut");
    expect(toSingleLine("")).toBe("");
    expect(toSingleLine("  two  spaces  ")).toBe("  two  spaces  ");
  });

  it("collapses every line-break spelling into ONE space each", () => {
    expect(toSingleLine("a\nb")).toBe("a b");
    expect(toSingleLine("a\r\nb")).toBe("a b");
    expect(toSingleLine("a\rb")).toBe("a b");
    expect(toSingleLine("a b c")).toBe("a b c");
    expect(toSingleLine("line one\n\nline two\n")).toBe("line one  line two ");
  });
});

describe("normalizeSingleLineChange", () => {
  it("collapses a pasted break into a single-line value", () => {
    expect(normalizeSingleLineChange("my-handle\nmore", "my-handle")).toBe("my-handle more");
  });

  it("keeps a value that was already stored with a break as it is", () => {
    expect(hasLineBreak("a\nb")).toBe(true);
    expect(normalizeSingleLineChange("a\nbX", "a\nb")).toBe("a\nbX");
  });
});

describe("isLineBreakKey", () => {
  it("is true for Enter in any modifier combination", () => {
    expect(isLineBreakKey({ key: "Enter" })).toBe(true);
    expect(isLineBreakKey({ key: "Enter", keyCode: 13 })).toBe(true);
  });

  it("is false for other keys and for an IME commit", () => {
    expect(isLineBreakKey({ key: "a" })).toBe(false);
    expect(isLineBreakKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(isLineBreakKey({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(false);
    expect(isLineBreakKey({ key: "Enter", keyCode: 229 })).toBe(false);
  });
});

function renderField(onChange: (v: string) => void, value = "Title") {
  return render(
    <AppProvider i18n={en}>
      <SingleLineTextField label="Title" value={value} onChange={onChange} />
    </AppProvider>,
  );
}

describe("SingleLineTextField", () => {
  it("renders a one-row textarea that wraps instead of an input", () => {
    const { container } = renderField(() => {});
    expect(container.querySelector("input[type=text]")).toBeNull();
    const area = container.querySelector("textarea");
    expect(area).not.toBeNull();
    expect(area!.getAttribute("rows")).toBe("1");
    expect(container.querySelector(".app-single-line-autogrow")).not.toBeNull();
  });

  it("cancels Enter and passes other keys", () => {
    const { container } = renderField(() => {});
    const area = container.querySelector("textarea")!;
    expect(fireEvent.keyDown(area, { key: "Enter", keyCode: 13 })).toBe(false);
    expect(fireEvent.keyDown(area, { key: "a" })).toBe(true);
  });

  it("hands a pasted line break on as a space", () => {
    const onChange = vi.fn();
    const { container } = renderField(onChange);
    const area = container.querySelector("textarea")!;
    fireEvent.change(area, { target: { value: "Title\r\nsecond line" } });
    expect(onChange).toHaveBeenLastCalledWith("Title second line");
  });

  it("server-renders the same one-row textarea (no hydration-only markup)", () => {
    const html = renderToString(
      <AppProvider i18n={en}>
        <SingleLineTextField label="Title" value="Title" onChange={() => {}} />
      </AppProvider>,
    );
    expect(html).toContain("<textarea");
    expect(html).toContain('rows="1"');
    expect(html).not.toMatch(/style="height/);
  });
});

describe("AutoGrowTextarea", () => {
  it("cancels Enter, collapses breaks and forwards the user's keydown", () => {
    const onValueChange = vi.fn();
    const onKeyDown = vi.fn();
    const { container } = render(
      <AutoGrowTextarea value="alt" onValueChange={onValueChange} onKeyDown={onKeyDown} />,
    );
    const area = container.querySelector("textarea")!;
    expect(area.getAttribute("rows")).toBe("1");
    expect(fireEvent.keyDown(area, { key: "Enter" })).toBe(false);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    fireEvent.change(area, { target: { value: "alt\ntext" } });
    expect(onValueChange).toHaveBeenLastCalledWith("alt text");
  });
});

describe("spellcheck", () => {
  it("is off by default in both boxes and can be switched on", () => {
    const { container } = render(
      <AppProvider i18n={en}>
        <SingleLineTextField label="Handle" value="my-handle" onChange={() => {}} />
        <AutoGrowTextarea value="alt" />
        <AutoGrowTextarea value="alt" spellCheck />
      </AppProvider>,
    );
    const areas = container.querySelectorAll("textarea");
    expect(areas[0].getAttribute("spellcheck")).toBe("false");
    expect(areas[1].getAttribute("spellcheck")).toBe("false");
    expect(areas[2].getAttribute("spellcheck")).toBe("true");
  });

  it("the hand-built box carries the sizing class (its min-height lives in CSS, not inline)", () => {
    const { container } = render(<AutoGrowTextarea value="" placeholder="inherited" />);
    const area = container.querySelector("textarea")!;
    expect(area.className).toContain("app-autogrow-textarea");
    expect(area.style.minHeight).toBe("");
  });
});

describe("infoBoxFitMode", () => {
  it("keeps a message that fits on one line at the normal size", () => {
    expect(infoBoxFitMode(300, 400)).toBe("single");
    expect(infoBoxFitMode(400, 400)).toBe("single");
    expect(infoBoxFitMode(400.4, 400)).toBe("single");
  });

  it("draws a longer message compact", () => {
    expect(infoBoxFitMode(401, 400)).toBe("compact");
    expect(infoBoxFitMode(2000, 400)).toBe("compact");
  });

  it("answers single while nothing can be measured yet", () => {
    expect(infoBoxFitMode(0, 400)).toBe("single");
    expect(infoBoxFitMode(500, 0)).toBe("single");
    expect(infoBoxFitMode(NaN, 400)).toBe("single");
  });

  it("two compact lines fit the strip's fixed height", () => {
    const compactContent = 2 * INFO_BOX_COMPACT.lineHeightPx + 2 * INFO_BOX_PADDING_Y + 2 * INFO_BOX_BORDER_PX;
    expect(compactContent).toBeLessThanOrEqual(INFO_BOX_STRIP_HEIGHT);
  });
});

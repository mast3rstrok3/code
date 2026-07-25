import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { SidebarBrand } from "./SidebarChrome";

function brandLink(onBackdrop: boolean) {
  return SidebarBrand({ onBackdrop }) as ReactElement<{
    readonly className: string;
    readonly children: ReactNode;
  }>;
}

function brandChildren(onBackdrop: boolean) {
  return Children.toArray(brandLink(onBackdrop).props.children);
}

describe("SidebarBrand", () => {
  it("renders the app name alone, without the T3 wordmark", () => {
    const children = brandChildren(false);

    expect(children).toHaveLength(1);
    const [label] = children;
    expect(isValidElement(label) && label.type).toBe("span");
    expect(
      isValidElement(label) &&
        (label as ReactElement<{ readonly children: ReactNode }>).props.children,
    ).toBe("Code");
  });

  it("lets the app name inherit the full-strength brand color", () => {
    const [label] = brandChildren(false);
    const className =
      (isValidElement(label) &&
        (label as ReactElement<{ readonly className: string }>).props.className) ||
      "";

    expect(className).toContain("truncate");
    expect(className).toContain("text-sm");
    expect(className).toContain("font-medium");
    expect(className).not.toContain("text-muted-foreground");
    expect(className).not.toContain("text-white/70");
  });

  it("keeps a single undimmed label on the stage backdrop", () => {
    const children = brandChildren(true);

    expect(children).toHaveLength(1);
    const [label] = children;
    const className =
      (isValidElement(label) &&
        (label as ReactElement<{ readonly className: string }>).props.className) ||
      "";

    expect(className).not.toContain("text-white/70");
    expect(className).not.toContain("text-muted-foreground");
  });

  it("drives brand color from the link for both backdrop states", () => {
    expect(brandLink(true).props.className).toContain("text-white");
    expect(brandLink(false).props.className).toContain("text-foreground");
  });
});

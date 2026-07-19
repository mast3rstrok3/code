import { describe, expect, it } from "vite-plus/test";

import { collectHierarchyPostOrder, orderHierarchyPostOrder } from "./threadHierarchy.js";

interface Node {
  readonly id: string;
  readonly parentId: string | null;
}

const accessors = {
  getId: (node: Node) => node.id,
  getParentId: (node: Node) => node.parentId,
};
const ids = (nodes: ReadonlyArray<Node>) => nodes.map((node) => node.id);

describe("thread hierarchy traversal", () => {
  it("collects a root and recursive descendants in post-order", () => {
    const nodes: Node[] = [
      { id: "parent", parentId: null },
      { id: "child", parentId: "parent" },
      { id: "grandchild", parentId: "child" },
    ];

    expect(ids(collectHierarchyPostOrder(nodes, "parent", accessors))).toEqual([
      "grandchild",
      "child",
      "parent",
    ]);
  });

  it("preserves sibling input order", () => {
    const nodes: Node[] = [
      { id: "parent", parentId: null },
      { id: "second", parentId: "parent" },
      { id: "first", parentId: "parent" },
    ];

    expect(ids(collectHierarchyPostOrder(nodes, "parent", accessors))).toEqual([
      "second",
      "first",
      "parent",
    ]);
  });

  it("returns an empty result for a missing root", () => {
    expect(
      collectHierarchyPostOrder([{ id: "orphan", parentId: "missing" }], "missing", accessors),
    ).toEqual([]);
  });

  it("orders complete forests and treats orphans as roots", () => {
    const nodes: Node[] = [
      { id: "root", parentId: null },
      { id: "child", parentId: "root" },
      { id: "orphan", parentId: "missing" },
    ];

    expect(ids(orderHierarchyPostOrder(nodes, accessors))).toEqual(["child", "root", "orphan"]);
  });

  it("terminates self-parent and multi-node cycles without duplicates", () => {
    const nodes: Node[] = [
      { id: "self", parentId: "self" },
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
      { id: "b", parentId: null },
    ];

    expect(ids(collectHierarchyPostOrder(nodes, "self", accessors))).toEqual(["self"]);
    expect(ids(collectHierarchyPostOrder(nodes, "a", accessors))).toEqual(["b", "a"]);
    expect(ids(orderHierarchyPostOrder(nodes, accessors))).toEqual(["self", "b", "a"]);
  });
});

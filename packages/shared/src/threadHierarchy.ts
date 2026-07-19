export interface HierarchyAccessors<TNode, TId> {
  readonly getId: (node: TNode) => TId;
  readonly getParentId: (node: TNode) => TId | null | undefined;
}

interface IndexedHierarchy<TNode, TId> {
  readonly nodes: ReadonlyArray<TNode>;
  readonly nodeById: ReadonlyMap<TId, TNode>;
  readonly childrenByParentId: ReadonlyMap<TId, ReadonlyArray<TNode>>;
}

function indexHierarchy<TNode, TId>(
  nodes: ReadonlyArray<TNode>,
  accessors: HierarchyAccessors<TNode, TId>,
): IndexedHierarchy<TNode, TId> {
  const uniqueNodes: TNode[] = [];
  const nodeById = new Map<TId, TNode>();

  for (const node of nodes) {
    const id = accessors.getId(node);
    if (nodeById.has(id)) continue;
    nodeById.set(id, node);
    uniqueNodes.push(node);
  }

  const childrenByParentId = new Map<TId, TNode[]>();
  for (const node of uniqueNodes) {
    const parentId = accessors.getParentId(node);
    if (parentId === null || parentId === undefined) continue;
    const children = childrenByParentId.get(parentId);
    if (children === undefined) {
      childrenByParentId.set(parentId, [node]);
    } else {
      children.push(node);
    }
  }

  return { nodes: uniqueNodes, nodeById, childrenByParentId };
}

function appendPostOrder<TNode, TId>(input: {
  readonly node: TNode;
  readonly accessors: HierarchyAccessors<TNode, TId>;
  readonly childrenByParentId: ReadonlyMap<TId, ReadonlyArray<TNode>>;
  readonly visiting: Set<TId>;
  readonly visited: Set<TId>;
  readonly result: TNode[];
}): void {
  const id = input.accessors.getId(input.node);
  if (input.visited.has(id) || input.visiting.has(id)) return;

  input.visiting.add(id);
  for (const child of input.childrenByParentId.get(id) ?? []) {
    appendPostOrder({ ...input, node: child });
  }
  input.visiting.delete(id);
  input.visited.add(id);
  input.result.push(input.node);
}

/**
 * Collect a node and every descendant in stable, child-first post-order.
 * Duplicate ids use their first input occurrence. Missing roots return an
 * empty array, and malformed cycles terminate without duplicate output.
 */
export function collectHierarchyPostOrder<TNode, TId>(
  nodes: ReadonlyArray<TNode>,
  rootId: TId,
  accessors: HierarchyAccessors<TNode, TId>,
): TNode[] {
  const hierarchy = indexHierarchy(nodes, accessors);
  const root = hierarchy.nodeById.get(rootId);
  if (root === undefined) return [];

  const result: TNode[] = [];
  appendPostOrder({
    node: root,
    accessors,
    childrenByParentId: hierarchy.childrenByParentId,
    visiting: new Set(),
    visited: new Set(),
    result,
  });
  return result;
}

/**
 * Order every node in a hierarchy or forest in stable, child-first
 * post-order. Orphans are treated as roots. Cycles and self-parent references
 * are emitted once in deterministic input order.
 */
export function orderHierarchyPostOrder<TNode, TId>(
  nodes: ReadonlyArray<TNode>,
  accessors: HierarchyAccessors<TNode, TId>,
): TNode[] {
  const hierarchy = indexHierarchy(nodes, accessors);
  const result: TNode[] = [];
  const visiting = new Set<TId>();
  const visited = new Set<TId>();

  for (const node of hierarchy.nodes) {
    const id = accessors.getId(node);
    const parentId = accessors.getParentId(node);
    if (
      parentId !== null &&
      parentId !== undefined &&
      parentId !== id &&
      hierarchy.nodeById.has(parentId)
    ) {
      continue;
    }
    appendPostOrder({
      node,
      accessors,
      childrenByParentId: hierarchy.childrenByParentId,
      visiting,
      visited,
      result,
    });
  }

  // Components made only of cycles have no natural root.
  for (const node of hierarchy.nodes) {
    appendPostOrder({
      node,
      accessors,
      childrenByParentId: hierarchy.childrenByParentId,
      visiting,
      visited,
      result,
    });
  }

  return result;
}

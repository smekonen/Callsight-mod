export interface OrderedLayoutNode {
  id: string;
  depth: number;
  width: number;
  height: number;
}

export interface OrderedLayoutEdge {
  source: string;
  target: string;
}

export type OrderedLayoutOrientation = 'TB' | 'LR';

/**
 * Lay out a forest so each parent aligns with its first child. Later children
 * occupy successive rows (LR) or columns (TB), producing a compact call list.
 */
export function layoutOrderedForest(
  nodes: OrderedLayoutNode[],
  edges: OrderedLayoutEdge[],
  orientation: OrderedLayoutOrientation,
  rankGap: number,
  siblingGap: number,
  margin = 50,
): Map<string, { x: number; y: number }> {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const children = new Map<string, string[]>();
  const childIds = new Set<string>();
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const group = children.get(edge.source) || [];
    group.push(edge.target);
    children.set(edge.source, group);
    childIds.add(edge.target);
  }

  const maxRankDimension = new Map<number, number>();
  let maxDepth = 0;
  for (const node of nodes) {
    maxDepth = Math.max(maxDepth, node.depth);
    const rankDimension = orientation === 'LR' ? node.width : node.height;
    maxRankDimension.set(node.depth, Math.max(maxRankDimension.get(node.depth) || 0, rankDimension));
  }
  const rankPosition = new Map<number, number>();
  let rankCursor = margin;
  for (let depth = 0; depth <= maxDepth; depth++) {
    rankPosition.set(depth, rankCursor);
    rankCursor += (maxRankDimension.get(depth) || 0) + rankGap;
  }

  const breadthSpan = new Map<string, number>();
  const calculateSpan = (nodeId: string): number => {
    const cached = breadthSpan.get(nodeId);
    if (cached !== undefined) return cached;
    const node = nodeById.get(nodeId)!;
    const ownBreadth = orientation === 'LR' ? node.height : node.width;
    const childSpans = (children.get(nodeId) || []).map(calculateSpan);
    const childrenBreadth = childSpans.length > 0
      ? childSpans.reduce((sum, span) => sum + span, 0) + siblingGap * (childSpans.length - 1)
      : 0;
    const span = Math.max(ownBreadth, childrenBreadth);
    breadthSpan.set(nodeId, span);
    return span;
  };

  const positions = new Map<string, { x: number; y: number }>();
  const place = (nodeId: string, breadthStart: number) => {
    const node = nodeById.get(nodeId)!;
    const rank = rankPosition.get(node.depth) || margin;
    positions.set(nodeId, orientation === 'LR'
      ? { x: rank, y: breadthStart }
      : { x: breadthStart, y: rank });

    let childCursor = breadthStart;
    for (const childId of children.get(nodeId) || []) {
      place(childId, childCursor);
      childCursor += calculateSpan(childId) + siblingGap;
    }
  };

  let forestCursor = margin;
  const roots = nodes.filter(node => !childIds.has(node.id));
  for (const root of roots) {
    place(root.id, forestCursor);
    forestCursor += calculateSpan(root.id) + siblingGap * 2;
  }
  // Defensive fallback for malformed input; the normal tree model is acyclic.
  for (const node of nodes) {
    if (!positions.has(node.id)) {
      place(node.id, forestCursor);
      forestCursor += calculateSpan(node.id) + siblingGap * 2;
    }
  }
  return positions;
}

import { CallEdge } from '@codeflow-map/core';

export interface FunctionContext {
  nodeIds: Set<string>;
  edges: Set<CallEdge>;
}

/**
 * Return the selected function, all upstream paths that lead to it, and its
 * complete downstream subtree. Edges crossing from an ancestor into a
 * different descendant branch are deliberately excluded.
 */
export function collectFunctionContext(focusedNodeId: string, edges: CallEdge[]): FunctionContext {
  const outgoing = new Map<string, CallEdge[]>();
  const incoming = new Map<string, CallEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) || []), edge]);
  }

  const nodeIds = new Set<string>([focusedNodeId]);
  const contextEdges = new Set<CallEdge>();
  const collectReachable = (adjacency: Map<string, CallEdge[]>, direction: 'upstream' | 'downstream') => {
    const queue = [focusedNodeId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      nodeIds.add(current);
      for (const edge of adjacency.get(current) || []) {
        contextEdges.add(edge);
        const adjacent = direction === 'upstream' ? edge.from : edge.to;
        nodeIds.add(adjacent);
        queue.push(adjacent);
      }
    }
  };

  collectReachable(incoming, 'upstream');
  collectReachable(outgoing, 'downstream');
  return { nodeIds, edges: contextEdges };
}

import { CallEdge, FunctionNode, Graph } from '@codeflow-map/core';

export interface TreeOccurrence {
  id: string;
  canonicalId: string;
  node: FunctionNode;
  depth: number;
  isCycleReference: boolean;
  incomingEdge?: CallEdge;
}

export interface TreeOccurrenceEdge {
  id: string;
  source: string;
  target: string;
  call: CallEdge;
}

export interface TreeViewModel {
  nodes: TreeOccurrence[];
  edges: TreeOccurrenceEdge[];
  truncated: boolean;
}

export const MAX_TREE_OCCURRENCES = 5_000;

/** Unfold the canonical call graph into a display-only forest of call occurrences. */
export function buildTreeViewModel(
  graph: Graph,
  maxOccurrences = MAX_TREE_OCCURRENCES,
): TreeViewModel {
  const canonicalNodes = new Map(graph.nodes.map(node => [node.id, node]));
  const outgoing = new Map<string, Array<{ call: CallEdge; index: number }>>();
  const incomingTargets = new Set<string>();

  graph.edges.forEach((call, index) => {
    if (!canonicalNodes.has(call.from) || !canonicalNodes.has(call.to)) return;
    const calls = outgoing.get(call.from) || [];
    calls.push({ call, index });
    outgoing.set(call.from, calls);
    incomingTargets.add(call.to);
  });
  outgoing.forEach(calls => calls.sort((a, b) => a.call.line - b.call.line || a.index - b.index));

  const rootIds: string[] = [];
  const rootSet = new Set<string>();
  const addRoot = (id: string | undefined) => {
    if (id && canonicalNodes.has(id) && !rootSet.has(id)) {
      rootSet.add(id);
      rootIds.push(id);
    }
  };

  graph.flows.forEach(flow => addRoot(flow.entryPoint));
  graph.nodes.forEach(node => {
    if (node.isEntryPoint || !incomingTargets.has(node.id)) addRoot(node.id);
  });
  if (rootIds.length === 0) addRoot(graph.nodes[0]?.id);

  const nodes: TreeOccurrence[] = [];
  const edges: TreeOccurrenceEdge[] = [];
  const representedCanonicalIds = new Set<string>();
  let sequence = 0;
  let truncated = false;

  function unfold(
    canonicalId: string,
    depth: number,
    ancestry: Set<string>,
    parentOccurrenceId?: string,
    incomingEdge?: CallEdge,
  ): string | null {
    if (nodes.length >= maxOccurrences) {
      truncated = true;
      return null;
    }

    const canonicalNode = canonicalNodes.get(canonicalId);
    if (!canonicalNode) return null;

    const isCycleReference = ancestry.has(canonicalId);
    const occurrenceId = `tree:${sequence++}:${canonicalId}`;
    nodes.push({
      id: occurrenceId,
      canonicalId,
      node: canonicalNode,
      depth,
      isCycleReference,
      incomingEdge,
    });
    representedCanonicalIds.add(canonicalId);

    if (parentOccurrenceId && incomingEdge) {
      edges.push({
        id: `tree-edge:${edges.length}:${parentOccurrenceId}->${occurrenceId}`,
        source: parentOccurrenceId,
        target: occurrenceId,
        call: incomingEdge,
      });
    }

    if (isCycleReference) return occurrenceId;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(canonicalId);
    for (const { call } of outgoing.get(canonicalId) || []) {
      if (nodes.length >= maxOccurrences) {
        truncated = true;
        break;
      }
      unfold(call.to, depth + 1, nextAncestry, occurrenceId, call);
    }
    return occurrenceId;
  }

  rootIds.forEach(rootId => unfold(rootId, 0, new Set()));

  // Preserve disconnected components and pure cycles that have no natural root.
  for (const node of graph.nodes) {
    if (nodes.length >= maxOccurrences) {
      truncated = true;
      break;
    }
    if (!representedCanonicalIds.has(node.id)) unfold(node.id, 0, new Set());
  }

  return { nodes, edges, truncated };
}


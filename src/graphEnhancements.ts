import {
  buildCallGraph as buildCoreCallGraph,
  CallEdge,
  FunctionNode,
  Logger,
  RawCall,
} from '@codeflow-map/core';
import { buildJavaEdges, isJavaRawCall, JavaRawCall } from './javaResolution';

type ExtendedRawCall = RawCall & {
  qualifiedCalleeName?: string;
  signatureLine?: number;
  signatureColumn?: number;
  symbolLine?: number;
  symbolColumn?: number;
};

export type SignatureCallSite = {
  filePath: string;
  signatureLine?: number;
  signatureColumn?: number;
  symbolLine?: number;
  symbolColumn?: number;
};

export type SignatureAwareCallEdge = CallEdge & {
  callSite?: SignatureCallSite;
  signature?: string;
  additionalOverloadCount?: number;
};

type ExternalFunctionNode = FunctionNode & {
  isExternal: true;
};

function findCaller(nodesByFile: Map<string, FunctionNode[]>, call: RawCall): FunctionNode | undefined {
  const candidates = (nodesByFile.get(call.callerFilePath) || []).filter(
    node => call.line >= node.startLine && call.line <= node.endLine,
  );

  return candidates.length > 0
    ? candidates.reduce((best, node) =>
        (node.endLine - node.startLine) < (best.endLine - best.startLine) ? node : best,
      )
    : undefined;
}

/**
 * Build normal workspace edges, then retain unresolved qualified Python calls
 * as one-hop external leaf nodes (for example, cv2.imdecode).
 */
export function buildEnhancedCallGraph(
  nodes: FunctionNode[],
  rawCalls: RawCall[],
  log?: Logger,
): CallEdge[] {
  // Java calls need type-aware resolution (overloads, inheritance, interfaces),
  // so they bypass the core name-based resolver.
  const javaCalls: JavaRawCall[] = [];
  const otherCalls: RawCall[] = [];
  for (const rawCall of rawCalls) {
    if (isJavaRawCall(rawCall)) javaCalls.push(rawCall);
    else otherCalls.push(rawCall);
  }

  const edges = buildCoreCallGraph(nodes, otherCalls, log);
  const originalNodes = [...nodes];
  const nodeById = new Map(originalNodes.map(node => [node.id, node]));
  const nodesByFile = new Map<string, FunctionNode[]>();

  for (const node of originalNodes) {
    const fileNodes = nodesByFile.get(node.filePath) || [];
    fileNodes.push(node);
    nodesByFile.set(node.filePath, fileNodes);
  }

  if (javaCalls.length > 0) {
    const javaEdges = buildJavaEdges(originalNodes, javaCalls, call => findCaller(nodesByFile, call));
    edges.push(...javaEdges);
    log?.(`Java calls: resolved ${javaEdges.length} edges from ${javaCalls.length} call sites`);
  }

  const externalNodes = new Map<string, ExternalFunctionNode>();
  const edgeKeys = new Set(edges.map(edge => `${edge.from}|${edge.to}|${edge.line}`));
  const resolvedCallKeys = new Set<string>();
  let externalEdgeCount = 0;

  for (const edge of edges) {
    const target = nodeById.get(edge.to);
    if (!target) continue;
    resolvedCallKeys.add(`${edge.from}|${edge.line}|${target.name}`);
    resolvedCallKeys.add(`${edge.from}|${edge.line}|${target.name.split('.').pop()}`);
  }

  for (const rawCall of rawCalls as ExtendedRawCall[]) {
    const qualifiedName = rawCall.qualifiedCalleeName;
    if (!qualifiedName || !qualifiedName.includes('.')) continue;

    const caller = findCaller(nodesByFile, rawCall);
    if (!caller || caller.language !== 'python') continue;

    // If the core resolver already connected this call to a workspace node,
    // it is internal even though its source spelling was qualified.
    const alreadyResolved = resolvedCallKeys.has(`${caller.id}|${rawCall.line}|${rawCall.calleeName}`);
    if (alreadyResolved) continue;

    const externalId = `external::python::${qualifiedName}`;
    let externalNode = externalNodes.get(externalId);
    if (!externalNode) {
      externalNode = {
        id: externalId,
        name: qualifiedName,
        filePath: '[external library]',
        startLine: 0,
        endLine: 0,
        params: [],
        returnType: null,
        isAsync: false,
        isExported: false,
        isEntryPoint: false,
        language: 'python',
        kind: 'function',
        isExternal: true,
      };
      externalNodes.set(externalId, externalNode);
    }

    const edgeKey = `${caller.id}|${externalId}|${rawCall.line}`;
    if (edgeKeys.has(edgeKey)) continue;
    edgeKeys.add(edgeKey);

    const externalEdge: SignatureAwareCallEdge = {
      from: caller.id,
      to: externalId,
      line: rawCall.line,
      ...(rawCall.callType ? { callType: rawCall.callType } : {}),
      callSite: {
        filePath: rawCall.callerFilePath,
        signatureLine: rawCall.signatureLine,
        signatureColumn: rawCall.signatureColumn,
        symbolLine: rawCall.symbolLine,
        symbolColumn: rawCall.symbolColumn,
      },
    };
    edges.push(externalEdge);
    externalEdgeCount++;
  }

  nodes.push(...externalNodes.values());
  log?.(`External Python calls: added ${externalNodes.size} leaf nodes and ${externalEdgeCount} edges`);
  return edges;
}

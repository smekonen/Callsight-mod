import { CallEdge, FunctionNode, RawCall } from '@codeflow-map/core';

/** Extra fields emitted by the patched core Java analyzer. */
export type JavaRawCall = RawCall & {
  javaMethodName: string;
  /** Candidate receiver types, most specific first; null when the receiver type is unknown. */
  javaReceiverTypes: string[] | null;
  /** Number of call arguments, -1 for method references. */
  javaArgCount: number;
};

type JavaFunctionNode = FunctionNode & {
  javaOwner: string | null;
  javaMethodName: string;
  javaSupertypes: string[];
  javaIsAnonymous: boolean;
  javaIsAbstract: boolean;
  javaIsVarArgs: boolean;
};

export function isJavaRawCall(call: RawCall): call is JavaRawCall {
  return typeof (call as JavaRawCall).javaMethodName === 'string';
}

function isJavaNode(node: FunctionNode): node is JavaFunctionNode {
  return node.language === 'java' && typeof (node as JavaFunctionNode).javaMethodName === 'string';
}

function matchesArity(node: JavaFunctionNode, argCount: number): boolean {
  if (argCount < 0) return true;
  if (node.javaIsVarArgs) return argCount >= node.params.length - 1;
  return node.params.length === argCount;
}

/**
 * Resolve Java calls using receiver types and the workspace type hierarchy:
 * inherited methods resolve upward, interface/abstract calls resolve to
 * implementations, and overloads are narrowed by argument count.
 */
export function buildJavaEdges(
  nodes: FunctionNode[],
  rawCalls: JavaRawCall[],
  findCaller: (call: RawCall) => FunctionNode | undefined,
): CallEdge[] {
  const methodsByOwner = new Map<string, Map<string, JavaFunctionNode[]>>();
  const methodsByName = new Map<string, JavaFunctionNode[]>();
  const supertypes = new Map<string, Set<string>>();
  const subtypes = new Map<string, Set<string>>();

  for (const node of nodes) {
    if (!isJavaNode(node) || !node.javaOwner) continue;
    const owner = node.javaOwner;
    const byMethod = methodsByOwner.get(owner) || new Map<string, JavaFunctionNode[]>();
    byMethod.set(node.javaMethodName, [...(byMethod.get(node.javaMethodName) || []), node]);
    methodsByOwner.set(owner, byMethod);
    methodsByName.set(node.javaMethodName, [...(methodsByName.get(node.javaMethodName) || []), node]);

    const supers = supertypes.get(owner) || new Set<string>();
    for (const superType of node.javaSupertypes) {
      supers.add(superType);
      // Anonymous classes are local; don't treat them as dispatch targets everywhere.
      if (node.javaIsAnonymous) continue;
      const subs = subtypes.get(superType) || new Set<string>();
      subs.add(owner);
      subtypes.set(superType, subs);
    }
    supertypes.set(owner, supers);
  }

  /** Breadth-first walk over the hierarchy, returning the first level that declares the method. */
  const lookUp = (type: string, method: string): JavaFunctionNode[] => {
    const visited = new Set<string>();
    let level = [type];
    while (level.length > 0) {
      const found = level.flatMap(t => methodsByOwner.get(t)?.get(method) || []);
      if (found.length > 0) return found;
      level.forEach(t => visited.add(t));
      level = level
        .flatMap(t => Array.from(supertypes.get(t) || []))
        .filter(t => !visited.has(t));
    }
    return [];
  };

  /** All concrete overrides of a method in (transitive) subtypes. */
  const lookDown = (type: string, method: string): JavaFunctionNode[] => {
    const visited = new Set<string>([type]);
    const queue = [type];
    const found: JavaFunctionNode[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const sub of subtypes.get(current) || []) {
        if (visited.has(sub)) continue;
        visited.add(sub);
        queue.push(sub);
        found.push(...(methodsByOwner.get(sub)?.get(method) || []).filter(n => !n.javaIsAbstract));
      }
    }
    return found;
  };

  const resolve = (call: JavaRawCall): JavaFunctionNode[] => {
    const method = call.javaMethodName;
    const byArity = (candidates: JavaFunctionNode[]) => candidates.filter(n => matchesArity(n, call.javaArgCount));

    if (call.javaReceiverTypes === null) {
      // Unknown receiver (e.g. chained calls): only link if the name is unambiguous.
      const candidates = byArity(methodsByName.get(method) || []).filter(n => !n.javaIsAnonymous);
      const owners = new Set(candidates.map(n => n.javaOwner));
      return owners.size === 1 ? candidates : [];
    }

    for (const type of call.javaReceiverTypes) {
      if (method === '<init>') {
        const ctors = methodsByOwner.get(type)?.get('<init>') || [];
        if (ctors.length > 0) return byArity(ctors).length > 0 ? byArity(ctors) : ctors;
        continue;
      }
      const declared = byArity(lookUp(type, method));
      const concrete = declared.filter(n => !n.javaIsAbstract);
      if (concrete.length > 0) return concrete;
      const overrides = byArity(lookDown(type, method));
      if (overrides.length > 0) return overrides;
      if (declared.length > 0) return declared;
    }
    return [];
  };

  const edges: CallEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const call of rawCalls) {
    const caller = findCaller(call);
    if (!caller) continue;
    for (const callee of resolve(call)) {
      if (callee.id === caller.id) continue;
      const key = `${caller.id}|${callee.id}|${call.line}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        from: caller.id,
        to: callee.id,
        line: call.line,
        ...(call.callType ? { callType: call.callType } : {}),
      });
    }
  }
  return edges;
}

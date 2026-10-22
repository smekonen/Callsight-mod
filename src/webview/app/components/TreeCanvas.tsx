import React, { useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Edge,
  MarkerType,
  Node,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import 'highlight.js/styles/github-dark.css';
import { Graph } from '@codeflow-map/core';
import FunctionNode from './FunctionNode';
import Minimap from './Minimap';
import { buildTreeViewModel, TreeOccurrence } from '../treeViewModel';
import { layoutOrderedForest } from '../orderedTreeLayout';
import type { GitFileLineDiff } from '../../../gitLineDiff';
import type { FunctionComment } from '../../../functionComments';

const nodeTypes = { functionNode: FunctionNode };
const TREE_NODE_WIDTH = 340;
const TREE_CODE_NODE_WIDTH = 820;
const TREE_NODE_BASE_HEIGHT = 140;
const TREE_LAYER_GAP = 220;

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);

export type TreeOrientation = 'TB' | 'LR';

function estimateTreeNodeHeight(
  occurrence: TreeOccurrence,
  source: string | undefined,
  fontSize: number,
  displayLineCount?: number,
  comment?: FunctionComment,
): number {
  if (source !== undefined) {
    const lineCount = displayLineCount ?? Math.max(1, source.split(/\r?\n/).length);
    const commentHeight = comment
      ? Math.ceil(Math.max(1, comment.text.split(/\r?\n/).length) * Math.max(14, fontSize) * 1.55)
        + (/@\w+/.test(comment.text) ? 72 : 40)
      : 0;
    return TREE_NODE_BASE_HEIGHT + Math.ceil(lineCount * fontSize * 1.5) + 28 + commentHeight;
  }
  const requestedHeight = (occurrence.node as any).displayHeight;
  return typeof requestedHeight === 'number'
    ? Math.max(TREE_NODE_BASE_HEIGHT, requestedHeight)
    : TREE_NODE_BASE_HEIGHT;
}

interface SourceDiffRow {
  kind: 'context' | 'added' | 'removed';
  oldLine?: number;
  newLine?: number;
  sourceLine?: number;
  html: string;
}

const highlightedCodeCache = new Map<string, { source: string; language: string; html: string }>();

function highlightSource(canonicalId: string, language: string, source: string): string {
  const normalizedLanguage = language === 'tsx'
    ? 'typescript'
    : language === 'jsx' ? 'javascript' : language;
  const cached = highlightedCodeCache.get(canonicalId);
  if (cached?.source === source && cached.language === normalizedLanguage) return cached.html;
  let html: string;
  try {
    html = hljs.highlight(source, { language: normalizedLanguage }).value;
  } catch {
    html = hljs.highlightAuto(source).value;
  }
  highlightedCodeCache.set(canonicalId, { source, language: normalizedLanguage, html });
  return html;
}

function highlightDiffLine(language: string, line: string): string {
  const normalizedLanguage = language === 'tsx'
    ? 'typescript'
    : language === 'jsx' ? 'javascript' : language;
  try {
    return hljs.highlight(line || ' ', { language: normalizedLanguage }).value;
  } catch {
    return hljs.highlightAuto(line || ' ').value;
  }
}

function buildSourceDiffRows(
  node: any,
  source: string,
  fileDiff: GitFileLineDiff | undefined,
  diffStatus: string | undefined,
): SourceDiffRow[] | undefined {
  const language = String(node.language || '');
  const sourceLines = source.split(/\r?\n/);
  const firstLine = node.startLine + 1;

  if (diffStatus === 'added' || diffStatus === 'removed') {
    return sourceLines.map((line, index) => ({
      kind: diffStatus,
      oldLine: diffStatus === 'removed' ? firstLine + index : undefined,
      newLine: diffStatus === 'added' ? firstLine + index : undefined,
      html: highlightDiffLine(language, line),
    }));
  }
  if (!fileDiff) return undefined;

  const lastLine = firstLine + sourceLines.length - 1;
  const addedLines = new Set<number>();
  const removedByAnchor = new Map<number, Array<{ oldLine?: number; content: string }>>();
  for (const hunk of fileDiff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added' && line.newLine !== undefined
        && line.newLine >= firstLine && line.newLine <= lastLine) {
        addedLines.add(line.newLine);
      }
      if (line.kind === 'removed' && line.anchorNewLine !== undefined
        && line.anchorNewLine >= firstLine && line.anchorNewLine <= lastLine + 1) {
        const rows = removedByAnchor.get(line.anchorNewLine) || [];
        rows.push({ oldLine: line.oldLine, content: line.content });
        removedByAnchor.set(line.anchorNewLine, rows);
      }
    }
  }
  if (addedLines.size === 0 && removedByAnchor.size === 0) return undefined;

  const rows: SourceDiffRow[] = [];
  for (let index = 0; index < sourceLines.length; index++) {
    const absoluteLine = firstLine + index;
    for (const removed of removedByAnchor.get(absoluteLine) || []) {
      rows.push({
        kind: 'removed',
        oldLine: removed.oldLine,
        html: highlightDiffLine(language, removed.content),
      });
    }
    const isAdded = addedLines.has(absoluteLine);
    rows.push({
      kind: isAdded ? 'added' : 'context',
      newLine: absoluteLine,
      sourceLine: index,
      html: highlightDiffLine(language, sourceLines[index]),
    });
  }
  for (const removed of removedByAnchor.get(lastLine + 1) || []) {
    rows.push({
      kind: 'removed',
      oldLine: removed.oldLine,
      html: highlightDiffLine(language, removed.content),
    });
  }
  return rows;
}

function functionHasLineDiff(node: any, fileDiff: GitFileLineDiff | undefined): boolean {
  if (!fileDiff) return false;
  const firstLine = node.startLine + 1;
  const lastLine = node.endLine + 1;
  return fileDiff.hunks.some(hunk => hunk.lines.some(line =>
    (line.kind === 'added' && line.newLine !== undefined
      && line.newLine >= firstLine && line.newLine <= lastLine)
    || (line.kind === 'removed' && line.anchorNewLine !== undefined
      && line.anchorNewLine >= firstLine && line.anchorNewLine <= lastLine + 1),
  ));
}

function layoutTree(
  graph: Graph,
  orientation: TreeOrientation,
  showCode: boolean,
  codeFontSize: number,
  functionSources: Record<string, string>,
  functionComments: Record<string, FunctionComment>,
  collapsedEdgeIds: Set<string>,
) {
  const model = buildTreeViewModel(graph);
  const occurrenceById = new Map(model.nodes.map(occurrence => [occurrence.id, occurrence]));
  const childEdges = new Map<string, typeof model.edges>();
  for (const edge of model.edges) {
    const group = childEdges.get(edge.source) || [];
    group.push(edge);
    childEdges.set(edge.source, group);
  }

  const hiddenOccurrenceIds = new Set<string>();
  const collapsedEdgesBySource = new Map<string, string[]>();
  const hideBranch = (occurrenceId: string) => {
    if (hiddenOccurrenceIds.has(occurrenceId)) return;
    hiddenOccurrenceIds.add(occurrenceId);
    for (const edge of childEdges.get(occurrenceId) || []) hideBranch(edge.target);
  };
  for (const edge of model.edges) {
    if (!collapsedEdgeIds.has(edge.id)) continue;
    hideBranch(edge.target);
    const ids = collapsedEdgesBySource.get(edge.source) || [];
    ids.push(edge.id);
    collapsedEdgesBySource.set(edge.source, ids);
  }

  const visibleOccurrences = model.nodes.filter(occurrence => !hiddenOccurrenceIds.has(occurrence.id));
  const visibleEdges = model.edges.filter(edge =>
    !collapsedEdgeIds.has(edge.id)
    && !hiddenOccurrenceIds.has(edge.source)
    && !hiddenOccurrenceIds.has(edge.target),
  );

  const callHighlightsByOccurrence = new Map<string, Array<{ line: number; column: number; length: number }>>();
  for (const edge of model.edges) {
    const caller = occurrenceById.get(edge.source);
    const callee = occurrenceById.get(edge.target);
    const source = caller ? functionSources[caller.canonicalId] : undefined;
    if (!caller || !callee || source === undefined) continue;
    const relativeLine = edge.call.line - caller.node.startLine;
    const sourceLine = source.split(/\r?\n/)[relativeLine];
    if (relativeLine < 0 || sourceLine === undefined) continue;
    const calleeName = callee.node.name.split('.').pop() || callee.node.name;
    const rawColumn = sourceLine.indexOf(calleeName);
    if (rawColumn < 0) continue;
    let visualColumn = 0;
    for (const character of sourceLine.slice(0, rawColumn)) {
      visualColumn += character === '\t' ? 4 - (visualColumn % 4) : 1;
    }
    const highlights = callHighlightsByOccurrence.get(edge.source) || [];
    if (!highlights.some(item => item.line === relativeLine && item.column === visualColumn && item.length === calleeName.length)) {
      highlights.push({ line: relativeLine, column: visualColumn, length: calleeName.length });
    }
    callHighlightsByOccurrence.set(edge.source, highlights);
  }

  const layoutNodes: Array<{ id: string; depth: number; width: number; height: number }> = [];

  const nodes: Node[] = visibleOccurrences.map(occurrence => {
    const incomingCall = occurrence.incomingEdge as any;
    const source = showCode && !(occurrence.node as any).isExternal
      ? functionSources[occurrence.canonicalId]
      : undefined;
    const documentation = source === undefined ? undefined : functionComments[occurrence.canonicalId];
    const width = source !== undefined ? TREE_CODE_NODE_WIDTH : TREE_NODE_WIDTH;
    const explicitDiffStatus = (graph as any).nodeDiffStatus?.[occurrence.canonicalId] as string | undefined;
    const fileDiff = ((graph as any).sourceDiffs?.[
      String(occurrence.node.filePath).replace(/\\/g, '/')
    ]) as GitFileLineDiff | undefined;
    const sourceDiffRows = source === undefined
      ? undefined
      : buildSourceDiffRows(occurrence.node, source, fileDiff, explicitDiffStatus);
    const diffStatus = explicitDiffStatus || (functionHasLineDiff(occurrence.node, fileDiff)
      ? (fileDiff?.oldPath === undefined ? 'added' : 'changed')
      : undefined);
    const height = estimateTreeNodeHeight(occurrence, source, codeFontSize, sourceDiffRows?.length, documentation);
    const data = {
      ...(occurrence.node as any),
      id: occurrence.id,
      canonicalId: occurrence.canonicalId,
      isCycleReference: occurrence.isCycleReference,
      layoutDirection: orientation === 'TB' ? 'vertical' : 'horizontal',
      displayWidth: width,
      codeHtml: source !== undefined
        ? highlightSource(occurrence.canonicalId, String((occurrence.node as any).language || ''), source)
        : undefined,
      sourceDiffRows,
      documentation,
      sourceStartLine: occurrence.node.startLine + 1,
      sourceLineCount: source?.split(/\r?\n/).length || 0,
      diffStatus,
      codeFontSize,
      callHighlights: callHighlightsByOccurrence.get(occurrence.id) || [],
      resizable: true,
      minimumHeight: height,
      collapsedChildCount: collapsedEdgesBySource.get(occurrence.id)?.length || 0,
      hasVisibleChildren: (childEdges.get(occurrence.id) || []).some(edge =>
        !collapsedEdgeIds.has(edge.id) && !hiddenOccurrenceIds.has(edge.target),
      ),
      signature: incomingCall?.signature || (occurrence.node as any).signature,
      additionalOverloadCount: incomingCall?.additionalOverloadCount
        ?? (occurrence.node as any).additionalOverloadCount,
    };
    layoutNodes.push({ id: occurrence.id, depth: occurrence.depth, width, height });
    return {
      id: occurrence.id,
      type: 'functionNode',
      data,
      position: { x: 0, y: 0 },
      draggable: true,
      style: { width, minHeight: height },
    };
  });

  const edges: Edge[] = visibleEdges.map(treeEdge => {
    return {
      id: treeEdge.id,
      source: treeEdge.source,
      target: treeEdge.target,
      type: 'step',
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
      style: { stroke: '#94a3b8', strokeWidth: 2 },
    };
  });

  const positions = layoutOrderedForest(
    layoutNodes,
    visibleEdges,
    orientation,
    orientation === 'TB' ? TREE_LAYER_GAP : 180,
    orientation === 'TB' ? 140 : 90,
  );
  const layoutedNodes = nodes.map(node => {
    return {
      ...node,
      position: positions.get(node.id) || { x: 0, y: 0 },
    };
  });

  const childEdgeIdsBySource = new Map(
    [...childEdges.entries()].map(([source, sourceEdges]) => [source, sourceEdges.map(edge => edge.id)]),
  );
  return {
    nodes: layoutedNodes,
    edges,
    truncated: model.truncated,
    collapsedEdgesBySource,
    childEdgeIdsBySource,
  };
}

interface TreeCanvasProps {
  graph: Graph;
  searchQuery: string;
  orientation: TreeOrientation;
  showCode: boolean;
  codeFontSize: number;
  functionSources: Record<string, string>;
  functionComments: Record<string, FunctionComment>;
  onFocusFunction: (canonicalId: string) => void;
}

export default function TreeCanvas({ graph, searchQuery, orientation, showCode, codeFontSize, functionSources, functionComments, onFocusFunction }: TreeCanvasProps) {
  const [collapsedEdgeIds, setCollapsedEdgeIds] = useState<Set<string>>(new Set());
  const initialLayout = useMemo(
    () => layoutTree(graph, orientation, showCode, codeFontSize, functionSources, functionComments, collapsedEdgeIds),
    [graph, orientation, showCode, codeFontSize, functionSources, functionComments, collapsedEdgeIds],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(initialLayout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialLayout.edges);
  const [hoveredCanonicalId, setHoveredCanonicalId] = useState<string | null>(null);

  const occurrenceToCanonical = useMemo(
    () => new Map(initialLayout.nodes.map(node => [node.id, (node.data as any).canonicalId as string])),
    [initialLayout.nodes],
  );

  useEffect(() => {
    setCollapsedEdgeIds(new Set());
  }, [graph]);

  useEffect(() => {
    setNodes(initialLayout.nodes);
    setEdges(initialLayout.edges);
    setHoveredCanonicalId(null);
  }, [initialLayout, setNodes, setEdges]);

  const displayNodes = useMemo(() => nodes.map(node => {
    const canonicalId = (node.data as any).canonicalId as string;
    const matchesHover = hoveredCanonicalId !== null && canonicalId === hoveredCanonicalId;
    const matchesSearch = !searchQuery
      || String((node.data as any).name || '').toLowerCase().includes(searchQuery.toLowerCase());
    return {
      ...node,
      data: {
        ...node.data,
        onHover: (occurrenceId: string) => setHoveredCanonicalId(occurrenceToCanonical.get(occurrenceId) || null),
        onHoverEnd: () => setHoveredCanonicalId(null),
        onFocus: () => onFocusFunction(canonicalId),
        onMinimizeChildren: (occurrenceId: string) => {
          const edgeIds = initialLayout.childEdgeIdsBySource.get(occurrenceId) || [];
          setCollapsedEdgeIds(previous => {
            const next = new Set(previous);
            edgeIds.forEach(id => next.add(id));
            return next;
          });
        },
        onRestoreChildren: (occurrenceId: string) => {
          const edgeIds = initialLayout.collapsedEdgesBySource.get(occurrenceId) || [];
          setCollapsedEdgeIds(previous => {
            const next = new Set(previous);
            edgeIds.forEach(id => next.delete(id));
            return next;
          });
        },
        analysisOverrides: matchesHover ? {
          borderColor: '#fbbf24',
          borderTopColor: '#fbbf24',
          boxShadow: '0 0 14px rgba(251, 191, 36, 0.75)',
        } : {},
      },
      style: {
        ...node.style,
        opacity: matchesSearch ? 1 : 0.18,
        transition: 'opacity 0.2s ease-in-out',
      },
    };
  }), [nodes, hoveredCanonicalId, occurrenceToCanonical, searchQuery, onFocusFunction, initialLayout.collapsedEdgesBySource, initialLayout.childEdgeIdsBySource]);

  const displayEdges = useMemo(() => edges.map(edge => ({
    ...edge,
    style: {
      ...edge.style,
      opacity: searchQuery ? 0.35 : 1,
      transition: 'opacity 0.2s ease-in-out',
    },
  })), [edges, searchQuery]);

  return (
    <>
      {initialLayout.truncated && (
        <div style={{
          position: 'absolute', top: 16, left: 16, zIndex: 10,
          padding: '7px 10px', borderRadius: '4px', fontSize: '12px',
          color: '#fbbf24', background: 'rgba(120, 53, 15, 0.88)',
          border: '1px solid rgba(251, 191, 36, 0.5)',
        }}>
          Tree display truncated at 5,000 call occurrences. The canonical graph remains complete.
        </div>
      )}
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgeClick={(event, edge) => {
          event.stopPropagation();
          setCollapsedEdgeIds(previous => {
            const next = new Set(previous);
            next.add(edge.id);
            return next;
          });
        }}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        minZoom={0.05}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={2} color="var(--vscode-editorLineNumber-foreground)" />
        <Controls style={{ backgroundColor: 'var(--vscode-editorWidget-background)' }} />
        <Minimap />
      </ReactFlow>
    </>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import FlowCanvas from './components/FlowCanvas';
import TreeCanvas, { TreeOrientation } from './components/TreeCanvas';
import Sidebar from './components/Sidebar';
import GraphLoader from './components/GraphLoader';
import { Graph, DiffGraph } from '@codeflow-map/core';
import { collectFunctionContext } from './graphContext';
import type { FunctionComment } from '../../functionComments';

export interface GraphAnalysisState {
  heatmap: boolean;
  impactRadius: boolean;
  impactDepth: number;
  circularDependency: boolean;
  complexityGlow: boolean;
  moduleClustering: boolean;
}

export type CanvasViewMode = 'graph' | 'tree';

// Declare VS Code API interface
declare global {
  interface Window {
    vscode: {
      postMessage: (msg: any) => void;
    };
  }
}

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFlows, setSelectedFlows] = useState<Set<string>>(new Set());
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [signatureTimeoutSeconds, setSignatureTimeoutSeconds] = useState(5);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [mode, setMode] = useState<'workspace' | 'file'>('workspace');
  const [viewMode, setViewMode] = useState<CanvasViewMode>('tree');
  const [treeOrientation, setTreeOrientation] = useState<TreeOrientation>('LR');
  const [showExternalFunctions, setShowExternalFunctions] = useState(false);
  const [showFunctionCode, setShowFunctionCode] = useState(true);
  const [codeFontSize, setCodeFontSize] = useState(12);
  const [functionSources, setFunctionSources] = useState<Record<string, string>>({});
  const [functionComments, setFunctionComments] = useState<Record<string, FunctionComment>>({});
  const requestedSourceIds = useRef(new Set<string>());

  // Diff state
  const [diffGraph, setDiffGraph] = useState<DiffGraph | null>(null);
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffProgress, setDiffProgress] = useState('');
  const [diffError, setDiffError] = useState<string | null>(null);
  const [gitAvailable, setGitAvailable] = useState<{ available: boolean; reason?: string }>({ available: true });
  const [singleFileBannerDismissed, setSingleFileBannerDismissed] = useState(false);
  const [focusHintDismissed, setFocusHintDismissed] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ scannedFiles: number; totalFiles: number } | null>(null);

  const [analysisState, setAnalysisState] = useState<GraphAnalysisState>({
    heatmap: false,
    impactRadius: false,
    impactDepth: 2,
    circularDependency: false,
    complexityGlow: false,
    moduleClustering: false
  });

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      // --- Chunked graph transfer protocol ---
      if (message.type === 'LOAD_GRAPH_START') {
        // Reset accumulators for incoming chunks
        (window as any).__graphNodes = [];
        (window as any).__graphEdges = [];
        (window as any).__graphMeta = message.meta;
        (window as any).__graphFlows = message.flows;
        (window as any).__graphOrphans = message.orphans;
        requestedSourceIds.current.clear();
        setFunctionSources({});
        setFunctionComments({});
        if (message.callsightConfig?.blacklist) {
          setBlacklist(message.callsightConfig.blacklist);
        }
        if (typeof message.callsightConfig?.signatureTimeoutSeconds === 'number') {
          setSignatureTimeoutSeconds(message.callsightConfig.signatureTimeoutSeconds);
        }
        if (message.mode) {
          setMode(message.mode);
        }
        setScanProgress({ scannedFiles: 0, totalFiles: message.totalNodes });
      }
      if (message.type === 'LOAD_GRAPH_NODES') {
        const acc = (window as any).__graphNodes as any[];
        acc.push(...message.nodes);
        const total = (window as any).__graphMeta ? (window as any).__graphMeta.scannedFiles : 0;
        setScanProgress({ scannedFiles: acc.length, totalFiles: acc.length });
      }
      if (message.type === 'LOAD_GRAPH_EDGES') {
        ((window as any).__graphEdges as any[]).push(...message.edges);
      }
      if (message.type === 'LOAD_GRAPH_END') {
        const meta = (window as any).__graphMeta || {};
        const assembled = {
          ...meta,
          nodes: (window as any).__graphNodes || [],
          edges: (window as any).__graphEdges || [],
          flows: (window as any).__graphFlows || [],
          orphans: (window as any).__graphOrphans || [],
        };
        // Clean up temporaries
        delete (window as any).__graphNodes;
        delete (window as any).__graphEdges;
        delete (window as any).__graphMeta;
        delete (window as any).__graphFlows;
        delete (window as any).__graphOrphans;
        setGraph(assembled);
        setScanProgress(null);
      }
      // Legacy single-message support (small graphs / single-file analysis)
      if (message.type === 'LOAD_GRAPH') {
        const { graph: loadedGraph, callsightConfig, mode: loadedMode } = message;
        setGraph(loadedGraph);
        requestedSourceIds.current.clear();
        setFunctionSources({});
        setFunctionComments({});
        setScanProgress(null);
        if (callsightConfig?.blacklist) {
          setBlacklist(callsightConfig.blacklist);
        }
        if (typeof callsightConfig?.signatureTimeoutSeconds === 'number') {
          setSignatureTimeoutSeconds(callsightConfig.signatureTimeoutSeconds);
        }
        if (loadedMode) {
          setMode(loadedMode);
        }
      }
      if (message.type === 'GIT_STATUS') {
        setGitAvailable({ available: message.available, reason: message.reason });
      }
      if (message.type === 'DIFF_PROGRESS') {
        setDiffProgress(message.message);
      }
      if (message.type === 'DIFF_RESULT') {
        requestedSourceIds.current.clear();
        setFunctionSources(message.diffGraph?.functionSources || {});
        setFunctionComments(message.diffGraph?.functionComments || {});
        setDiffGraph(message.diffGraph);
        setIsDiffMode(true);
        setDiffLoading(false);
        setDiffProgress('');
        setDiffError(null);
      }
      if (message.type === 'DIFF_ERROR') {
        setDiffError(message.error);
        setDiffLoading(false);
        setDiffProgress('');
      }
      if (message.type === 'SCAN_PROGRESS') {
        setScanProgress({ scannedFiles: message.scannedFiles, totalFiles: message.totalFiles });
      }
      if (message.type === 'FUNCTION_SOURCES' && Array.isArray(message.sources)) {
        setFunctionSources(previous => {
          const next = { ...previous };
          for (const item of message.sources) {
            if (typeof item?.id === 'string' && typeof item?.source === 'string') {
              next[item.id] = item.source;
            }
          }
          return next;
        });
        setFunctionComments(previous => {
          const next = { ...previous };
          for (const item of message.sources) {
            if (typeof item?.id === 'string' && item.comment && typeof item.comment.text === 'string') {
              next[item.id] = item.comment;
            }
          }
          return next;
        });
      }
    };

    window.addEventListener('message', handleMessage);
    
    // Tell extension we are ready to receive data
    window.vscode.postMessage({ type: 'READY' });
    // Check git availability
    window.vscode.postMessage({ type: 'CHECK_GIT_AVAILABLE' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const requestDiffCompare = (hashA: string, hashB: string) => {
    setDiffLoading(true);
    setDiffError(null);
    setDiffProgress('Starting comparison...');
    window.vscode.postMessage({
      type: 'REQUEST_DIFF_COMPARE',
      hashA: hashA.trim() || undefined,
      hashB: hashB.trim() || undefined,
    });
  };

  const exitDiffMode = () => {
    setIsDiffMode(false);
    setDiffGraph(null);
    requestedSourceIds.current.clear();
    setFunctionSources({});
    setFunctionComments({});
    setDiffError(null);
    setDiffProgress('');
  };

  // In diff mode, use diffGraph; otherwise use regular graph
  const activeGraph = isDiffMode && diffGraph ? diffGraph : graph;
  const effectiveViewMode: CanvasViewMode = viewMode;

  const isLargeGraph = activeGraph ? activeGraph.nodes.length > 500 : false;
  
  // Filter nodes by selected flows and/or focused node.
  // For large graphs with no selection, show nothing (user must pick a flow).
  // For small graphs with no selection, show everything.
  const displayGraph = React.useMemo(() => {
    if (!activeGraph) return null;

    const hasSelection = selectedFlows.size > 0 || focusedNodeId;

    let selectedGraph: Graph | DiffGraph | null = null;

    // No selection: large graphs show empty, small graphs show full
    if (!hasSelection) {
      selectedGraph = isLargeGraph ? null : activeGraph;
    } else {
      const activeNodeIds = new Set<string>();
      let focusedEdges: Set<any> | undefined;

      if (selectedFlows.size > 0) {
        activeGraph.flows.forEach(f => {
          if (selectedFlows.has(f.id)) {
            f.nodeIds.forEach(id => activeNodeIds.add(id));
          }
        });
      }

      if (focusedNodeId) {
        const context = collectFunctionContext(focusedNodeId, activeGraph.edges);
        context.nodeIds.forEach(id => activeNodeIds.add(id));
        focusedEdges = context.edges;
      }

      const filteredNodes = activeGraph.nodes.filter(n => activeNodeIds.has(n.id));
      const filteredEdges = activeGraph.edges.filter(e =>
        activeNodeIds.has(e.from)
        && activeNodeIds.has(e.to)
        && (!focusedEdges || focusedEdges.has(e)),
      );
      const filteredFlows = activeGraph.flows.filter(f => selectedFlows.has(f.id));
      selectedGraph = { ...activeGraph, nodes: filteredNodes, edges: filteredEdges, flows: filteredFlows };
    }

    if (!selectedGraph || showExternalFunctions) return selectedGraph;

    const visibleNodeIds = new Set(selectedGraph.nodes.filter((node: any) => !node.isExternal).map(node => node.id));
    return {
      ...selectedGraph,
      nodes: selectedGraph.nodes.filter(node => visibleNodeIds.has(node.id)),
      edges: selectedGraph.edges.filter(edge => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)),
      flows: selectedGraph.flows
        .map(flow => ({ ...flow, nodeIds: flow.nodeIds.filter(id => visibleNodeIds.has(id)) }))
        .filter(flow => flow.nodeIds.length > 0),
      orphans: selectedGraph.orphans.filter(id => visibleNodeIds.has(id)),
    };
  }, [activeGraph, isLargeGraph, selectedFlows, focusedNodeId, showExternalFunctions]);

  useEffect(() => {
    if (effectiveViewMode !== 'tree' || !showFunctionCode || !displayGraph) return;
    const missingIds = displayGraph.nodes
      .filter((node: any) => node.isExternal !== true)
      .map(node => node.id)
      .filter(id => functionSources[id] === undefined && !requestedSourceIds.current.has(id));
    if (missingIds.length === 0) return;
    missingIds.forEach(id => requestedSourceIds.current.add(id));
    window.vscode.postMessage({ type: 'REQUEST_FUNCTION_SOURCES', nodeIds: missingIds });
  }, [displayGraph, effectiveViewMode, showFunctionCode, functionSources]);

  const focusFunction = (nodeId: string) => {
    setSelectedFlows(new Set());
    setFocusedNodeId(previous => previous === nodeId ? null : nodeId);
  };

  const setCanvasFocusedNodeId = (nodeId: string | null) => {
    if (nodeId === null) {
      setFocusedNodeId(null);
    } else {
      focusFunction(nodeId);
    }
  };

  const triggerReanalysis = () => {
    if (isDiffMode) exitDiffMode();
    if (mode === 'file') {
      window.vscode.postMessage({ type: 'REFRESH_CURRENT_FILE' });
    } else {
      window.vscode.postMessage({
        type: 'UPDATE_SCAN_SETTINGS',
        blacklist,
        signatureTimeoutSeconds,
      });
    }
  };

  if (!activeGraph) {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-editor-foreground)', flexDirection: 'column', gap: '8px' }}>
        <GraphLoader
          message="Scanning codebase..."
          submessage={scanProgress ? `Scanned ${scanProgress.scannedFiles} / ${scanProgress.totalFiles} files` : undefined}
        />
      </div>
    );
  }

  if (activeGraph.nodes.length === 0 && !isDiffMode) {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-editor-foreground)' }}>
        <p>No functions found in this analysis.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', backgroundColor: 'var(--vscode-editor-background)' }}>
      <Sidebar 
        graph={activeGraph} 
        searchQuery={searchQuery} 
        onSearchChange={setSearchQuery}
        analysisState={analysisState}
        setAnalysisState={setAnalysisState}
        selectedFlows={selectedFlows}
        setSelectedFlows={setSelectedFlows}
        blacklist={blacklist}
        setBlacklist={setBlacklist}
        signatureTimeoutSeconds={signatureTimeoutSeconds}
        setSignatureTimeoutSeconds={setSignatureTimeoutSeconds}
        isLargeGraph={isLargeGraph}
        focusedNodeId={focusedNodeId}
        setFocusedNodeId={setFocusedNodeId}
        isDiffMode={isDiffMode}
        diffLoading={diffLoading}
        diffProgress={diffProgress}
        diffError={diffError}
        gitAvailable={gitAvailable}
        onRequestDiffCompare={requestDiffCompare}
        onExitDiffMode={exitDiffMode}
        diffGraph={diffGraph}
        mode={mode}
        viewMode={effectiveViewMode}
        setViewMode={setViewMode}
        treeOrientation={treeOrientation}
        setTreeOrientation={setTreeOrientation}
        showExternalFunctions={showExternalFunctions}
        setShowExternalFunctions={setShowExternalFunctions}
        showFunctionCode={showFunctionCode}
        setShowFunctionCode={setShowFunctionCode}
        codeFontSize={codeFontSize}
        setCodeFontSize={setCodeFontSize}
      />
      <div style={{ flex: 1, position: 'relative' }}>
        <button
          type="button"
          className="canvas-reload nodrag nopan"
          style={{ top: !isDiffMode && graph?.scannedFiles === 1 && !singleFileBannerDismissed ? '58px' : undefined }}
          onClick={triggerReanalysis}
          title="Re-analyze"
          aria-label="Re-analyze"
        >
          ↻
        </button>
        {/* Diff loading overlay */}
        {diffLoading && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20,
            background: 'rgba(0,0,0,0.95)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--vscode-editor-foreground)'
          }}>
            <GraphLoader
              message={diffProgress || 'Computing diff...'}
            />
          </div>
        )}

        {!isDiffMode && graph?.scannedFiles === 1 && !singleFileBannerDismissed && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, zIndex: 15,
            background: 'rgba(245, 158, 11, 0.15)',
            borderBottom: '1px solid rgba(245, 158, 11, 0.4)',
            color: '#fbbf24',
            padding: '8px 16px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            fontSize: '13px',
            backdropFilter: 'blur(8px)',
          }}>
            <span style={{ lineHeight: 1.4 }}>
              ⚠ Single file scan — entry points and call edges may be incomplete. Functions that only call external code will appear as orphans. Use 'Visualize Entire Workspace' for accurate results.
            </span>
            <button
              onClick={() => setSingleFileBannerDismissed(true)}
              style={{
                background: 'none', border: 'none', color: '#fbbf24', cursor: 'pointer',
                fontSize: '16px', padding: '2px 6px', marginLeft: '12px', flexShrink: 0,
              }}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {!displayGraph && isLargeGraph && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 10, color: 'var(--vscode-editor-foreground)', textAlign: 'center' }}>
            <h2>Large Codebase Detected ({activeGraph.nodes.length} nodes)</h2>
            <p>Please select one or more flows from the sidebar to render this view.</p>
          </div>
        )}
        {displayGraph && effectiveViewMode === 'tree' && (
          <TreeCanvas
            graph={displayGraph}
            searchQuery={searchQuery}
            orientation={treeOrientation}
            showCode={showFunctionCode}
            codeFontSize={codeFontSize}
            functionSources={functionSources}
            functionComments={functionComments}
            onFocusFunction={focusFunction}
          />
        )}
        {displayGraph && effectiveViewMode === 'graph' && (
          <FlowCanvas 
            graph={displayGraph} 
            searchQuery={searchQuery} 
            analysisState={analysisState}
            focusedNodeId={focusedNodeId}
            setFocusedNodeId={setCanvasFocusedNodeId}
            isDiffMode={isDiffMode}
            diffGraph={isDiffMode ? diffGraph : null}
          />
        )}
        {/* Function focus hint */}
        {effectiveViewMode === 'graph' && focusedNodeId && !focusHintDismissed && (
          <div style={{
            position: 'absolute', bottom: 16, right: 16, zIndex: 10,
            maxWidth: '280px',
            background: 'rgba(30, 41, 59, 0.92)',
            border: '1px solid rgba(148, 163, 184, 0.2)',
            borderRadius: '6px',
            padding: '10px 12px',
            backdropFilter: 'blur(8px)',
            color: 'var(--vscode-editor-foreground)',
            fontSize: '12px',
            lineHeight: '1.5',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}>
            <span style={{ opacity: 0.8 }}>
              Showing the selected function with all of its upstream callers and downstream callees.
            </span>
            <button
              onClick={() => setFocusHintDismissed(true)}
              style={{
                background: 'none', border: 'none', color: 'var(--vscode-editor-foreground)',
                cursor: 'pointer', fontSize: '14px', padding: '0', flexShrink: 0, opacity: 0.6, lineHeight: 1,
              }}
              aria-label="Dismiss"
            >✕</button>
          </div>
        )}
      </div>
    </div>
  );
}

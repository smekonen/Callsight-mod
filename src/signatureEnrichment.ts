import * as vscode from 'vscode';
import { CallEdge, FunctionNode, Logger } from '@codeflow-map/core';
import { SignatureAwareCallEdge } from './graphEnhancements';

type SignatureNode = FunctionNode & {
  isExternal?: boolean;
  signature?: string;
  additionalOverloadCount?: number;
};

const SIGNATURE_LOOKUP_CONCURRENCY = 8;

/** Ask the active language provider (normally Pylance) for external call signatures. */
export async function enrichExternalSignatures(
  nodes: FunctionNode[],
  edges: CallEdge[],
  fileUris: Map<string, vscode.Uri>,
  timeoutMs = 5_000,
  log?: Logger,
): Promise<void> {
  const nodesById = new Map(nodes.map(node => [node.id, node as SignatureNode]));
  const callSiteCandidates = (edges as SignatureAwareCallEdge[]).filter(edge => {
    const target = nodesById.get(edge.to);
    const site = edge.callSite;
    return target?.isExternal === true
      && site !== undefined
      && typeof site.signatureLine === 'number'
      && typeof site.signatureColumn === 'number'
      && fileUris.has(site.filePath);
  });

  if (callSiteCandidates.length === 0) return;

  // The current graph displays one node per external symbol, so only query its
  // first call site. Every edge still retains its call-site metadata for the
  // future occurrence-tree view.
  const candidateByTarget = new Map<string, SignatureAwareCallEdge>();
  for (const edge of callSiteCandidates) {
    if (!candidateByTarget.has(edge.to)) candidateByTarget.set(edge.to, edge);
  }
  const candidates = [...candidateByTarget.values()];

  const documentPromises = new Map<string, Thenable<vscode.TextDocument>>();
  let nextIndex = 0;
  let attemptedCount = 0;
  let enrichedCount = 0;
  let failureCount = 0;
  let stopped = false;

  log?.(`External signatures: looking up ${candidates.length} unique functions (${timeoutMs / 1000}s budget)...`);

  async function enrichOne(edge: SignatureAwareCallEdge): Promise<void> {
    const site = edge.callSite!;
    const uri = fileUris.get(site.filePath)!;

    try {
      let documentPromise = documentPromises.get(uri.toString());
      if (!documentPromise) {
        documentPromise = vscode.workspace.openTextDocument(uri);
        documentPromises.set(uri.toString(), documentPromise);
      }
      const document = await documentPromise;
      if (stopped) return;
      const line = Math.min(site.signatureLine!, Math.max(0, document.lineCount - 1));
      const column = Math.min(site.signatureColumn!, document.lineAt(line).text.length);
      const help = await vscode.commands.executeCommand<vscode.SignatureHelp | undefined>(
        'vscode.executeSignatureHelpProvider',
        uri,
        new vscode.Position(line, column),
        '(',
      );

      if (stopped) return;
      if (!help || help.signatures.length === 0) return;
      const activeIndex = Math.min(Math.max(help.activeSignature || 0, 0), help.signatures.length - 1);
      const signature = help.signatures[activeIndex]?.label?.trim();
      if (!signature) return;

      const additionalOverloadCount = Math.max(0, help.signatures.length - 1);
      edge.signature = signature;
      edge.additionalOverloadCount = additionalOverloadCount;

      const target = nodesById.get(edge.to);
      if (target && !target.signature) {
        target.signature = signature;
        target.additionalOverloadCount = additionalOverloadCount;
      }
      enrichedCount++;
    } catch {
      failureCount++;
    }
  }

  async function worker(): Promise<void> {
    while (!stopped && nextIndex < candidates.length) {
      const edge = candidates[nextIndex++];
      attemptedCount++;
      await enrichOne(edge);
    }
  }

  const lookups = Promise.all(
    Array.from(
      { length: Math.min(SIGNATURE_LOOKUP_CONCURRENCY, candidates.length) },
      () => worker(),
    ),
  );

  let timeoutHandle: NodeJS.Timeout | undefined;
  const completedWithinBudget = await Promise.race([
    lookups.then(() => true),
    new Promise<boolean>(resolve => {
      timeoutHandle = setTimeout(() => {
        stopped = true;
        resolve(false);
      }, timeoutMs);
    }),
  ]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  log?.(`External signatures: enriched ${enrichedCount}/${attemptedCount} attempted functions${failureCount > 0 ? `, ${failureCount} failed` : ''}${completedWithinBudget ? '' : `; time budget reached, continuing without the rest`}`);
}

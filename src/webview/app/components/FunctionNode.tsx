import React, { useState } from 'react';
import { Handle, NodeResizer, Position } from '@xyflow/react';
import { parse as parseComment, type Spec } from 'comment-parser';

const TREE_RESIZE_MIN_WIDTH = 300;

function stableFileColor(filePath: string): string {
  let hash = 0;
  for (let index = 0; index < filePath.length; index++) {
    hash = ((hash << 5) - hash + filePath.charCodeAt(index)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 78% 72%)`;
}

function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  return text.split(tokenPattern).filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}:${index}`;
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code className="fn-doc-inline-code" key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) {
      return <a href={link[2]} target="_blank" rel="noreferrer" key={key}>{link[1]}</a>;
    }
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

function MarkdownDocumentation({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index++;
      continue;
    }
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith('```')) codeLines.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<pre className="fn-doc-code-block" key={`code:${index}`}><code>{codeLines.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const Heading = `h${Math.min(4, heading[1].length + 2)}` as keyof React.JSX.IntrinsicElements;
      blocks.push(<Heading className="fn-doc-heading" key={`heading:${index}`}>{renderInlineMarkdown(heading[2], `heading:${index}`)}</Heading>);
      index++;
      continue;
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*+]\s+/, ''));
        index++;
      }
      blocks.push(<ul className="fn-doc-list" key={`list:${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item, `list:${index}:${itemIndex}`)}</li>)}</ul>);
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) quoteLines.push(lines[index++].trim().replace(/^>\s?/, ''));
      blocks.push(<blockquote className="fn-doc-quote" key={`quote:${index}`}>{renderInlineMarkdown(quoteLines.join(' '), `quote:${index}`)}</blockquote>);
      continue;
    }
    const tag = /^(@\w+)\s*(.*)$/.exec(trimmed);
    if (tag) {
      blocks.push(<div className="fn-doc-tag-row" key={`tag:${index}`}><span>{tag[1]}</span>{renderInlineMarkdown(tag[2], `tag:${index}`)}</div>);
      index++;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index].trim();
      if (!candidate || candidate.startsWith('```') || /^(#{1,4})\s+/.test(candidate)
        || /^[-*+]\s+/.test(candidate) || candidate.startsWith('>') || /^@\w+\s*/.test(candidate)) break;
      paragraph.push(candidate);
      index++;
    }
    blocks.push(<p key={`paragraph:${index}`}>{renderInlineMarkdown(paragraph.join(' '), `paragraph:${index}`)}</p>);
  }
  return <>{blocks}</>;
}

function JsDocTag({ spec }: { spec: Spec }) {
  const tag = spec.tag.toLowerCase();
  const label = tag === 'return' || tag === 'returns'
    ? 'Returns'
    : tag === 'throw' || tag === 'throws' || tag === 'exception'
      ? 'Throws'
      : `@${spec.tag}`;

  return (
    <div className={`fn-jsdoc-tag fn-jsdoc-tag--${tag}`}>
      <span className="fn-jsdoc-tag-label">{label}</span>
      {(spec.name || spec.type) && (
        <span className="fn-jsdoc-tag-signature">
          {spec.name && <strong>{spec.name}{spec.optional ? '?' : ''}</strong>}
          {spec.type && <code>{spec.type}</code>}
        </span>
      )}
      {spec.description && (
        <span className="fn-jsdoc-tag-description">
          {renderInlineMarkdown(spec.description, `jsdoc:${spec.tag}:${spec.name}`)}
        </span>
      )}
    </div>
  );
}

function asJsDocSource(text: string): string {
  const body = text
    .replace(/\*\//g, '*\\/')
    .split(/\r?\n/)
    .map(line => ` * ${line}`)
    .join('\n');
  return `/**\n${body}\n */`;
}

function JsDocDocumentation({ text }: { text: string }) {
  let block;
  try {
    block = parseComment(asJsDocSource(text), { spacing: 'preserve' })[0];
  } catch {
    block = undefined;
  }

  if (!block) return <MarkdownDocumentation text={text} />;

  const parameters = block.tags.filter(spec => spec.tag.toLowerCase() === 'param');
  const otherTags = block.tags.filter(spec => spec.tag.toLowerCase() !== 'param');

  return (
    <div className="fn-jsdoc">
      {block.description && (
        <div className="fn-jsdoc-description">
          <MarkdownDocumentation text={block.description} />
        </div>
      )}
      {parameters.length > 0 && (
        <div className="fn-jsdoc-section">
          <div className="fn-jsdoc-section-title">Parameters</div>
          {parameters.map((spec, index) => (
            <JsDocTag spec={spec} key={`${spec.name}:${index}`} />
          ))}
        </div>
      )}
      {otherTags.length > 0 && (
        <div className="fn-jsdoc-section">
          {otherTags.map((spec, index) => (
            <JsDocTag spec={spec} key={`${spec.tag}:${spec.name}:${index}`} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FunctionNode({ data, selected }: { data: any; selected?: boolean }) {
  const [isHovered, setIsHovered] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const paramsList = data.params.map((p: any) => p.type ? `${p.name}: ${p.type}` : p.name).join(', ');

  const diffStatus: string | undefined = data.diffStatus; // 'added' | 'removed' | 'changed' | 'unchanged' | undefined
  const isGhost = diffStatus === 'removed';
  const isExternal = data.isExternal === true;
  const isVerticalLayout = data.layoutDirection === 'vertical';
  const isTreeLayout = isVerticalLayout || data.layoutDirection === 'horizontal';
  const treeHandleStyle = !isTreeLayout ? {} : isVerticalLayout ? { left: '28px' } : { top: '28px' };
  const signature = typeof data.signature === 'string' ? data.signature : '';
  const additionalOverloadCount = typeof data.additionalOverloadCount === 'number'
    ? data.additionalOverloadCount
    : 0;
  const signatureReturnSeparator = signature.lastIndexOf('->');
  const signatureParams = signatureReturnSeparator >= 0
    ? signature.substring(0, signatureReturnSeparator).trim()
    : signature;
  const signatureReturnType = signatureReturnSeparator >= 0
    ? signature.substring(signatureReturnSeparator + 2).trim()
    : '';
  const displayReturnType = signatureReturnType || data.returnType;

  const handleGoto = () => {
    if (isGhost || isExternal) return; // Ghost/external nodes have no local source location
    window.vscode.postMessage({
      type: 'GOTO_FUNCTION',
      filePath: data.filePath,
      startLine: data.startLine
    });
  };

  const handleNodeClick = (event: React.MouseEvent) => {
    if (isGhost) return;
    if (event.altKey) {
      handleGoto();
      return;
    }
    data.onFocus?.(data.canonicalId || data.id);
  };

  // Get last 2 segments of path
  const pathParts = data.filePath.split(/[/\\]/);
  const shortPath = pathParts.slice(-2).join('/');
  const fileColor = stableFileColor(data.filePath);

  let kindColor = '#2d2d2d'; // default function dark
  let borderColor = '#444'; 
  
  switch (data.kind) {
    case 'component':
      kindColor = '#0f766e'; // teal
      borderColor = '#134e4a';
      break;
    case 'hook':
      kindColor = '#6b21a8'; // purple
      borderColor = '#4c1d95';
      break;
    case 'class':
      kindColor = '#9a3412'; // orange
      borderColor = '#7c2d12';
      break;
    case 'method':
      kindColor = '#1e40af'; // blue
      borderColor = '#1e3a8a';
      break;
  }

  if (isExternal) {
    kindColor = '#475569'; // slate
    borderColor = '#64748b';
  }

  // Diff status overrides
  if (diffStatus === 'added') {
    borderColor = '#22c55e';
  } else if (diffStatus === 'removed') {
    borderColor = '#ef4444';
  } else if (diffStatus === 'changed') {
    borderColor = '#f59e0b';
  }

  // Analysis overrides from FlowCanvas (heatmap, cycles, clusters, glow)
  const overrides = data.analysisOverrides || {};
  const finalBorderColor = overrides.borderColor || borderColor;
  const finalTopColor = overrides.borderTopColor || kindColor;
  const clusterBg = overrides.backgroundColor || undefined;

  return (
    <div 
      className="function-node" 
      onClick={handleNodeClick}
      onMouseEnter={() => { setIsHovered(true); data.onHover?.(data.id); }}
      onMouseLeave={() => {
        if (!isResizing) setIsHovered(false);
        data.onHoverEnd?.();
      }}
      title={isExternal ? undefined : 'Click to focus this function; Alt+click to open its source'}
      style={{ 
        position: 'relative',
        borderColor: finalBorderColor, 
        borderTopWidth: 4, 
        borderTopColor: diffStatus === 'added' ? '#22c55e' : diffStatus === 'removed' ? '#ef4444' : diffStatus === 'changed' ? '#f59e0b' : finalTopColor,
        borderStyle: isGhost ? 'dashed' : 'solid',
        boxShadow: overrides.boxShadow || undefined,
        background: clusterBg ? `${clusterBg}22` : undefined,
        opacity: isGhost ? 0.85 : 1,
        cursor: isGhost || typeof data.onFocus !== 'function' ? 'default' : 'pointer',
        width: data.resizable ? '100%' : typeof data.displayWidth === 'number' ? data.displayWidth : undefined,
        height: data.resizable ? '100%' : undefined,
        boxSizing: 'border-box',
      }}
    >
      {data.resizable && (
        <NodeResizer
          isVisible={isHovered || Boolean(selected) || isResizing}
          minWidth={TREE_RESIZE_MIN_WIDTH}
          minHeight={typeof data.minimumHeight === 'number' ? data.minimumHeight : 140}
          maxWidth={1400}
          handleStyle={{ opacity: 0 }}
          lineStyle={{ borderColor: '#60a5fa' }}
          onResizeStart={() => setIsResizing(true)}
          onResizeEnd={() => { setIsResizing(false); setIsHovered(false); }}
        />
      )}
      <Handle type="target" position={isVerticalLayout ? Position.Top : Position.Left} style={{ background: '#555', border: 'none', width: '8px', height: '8px', ...treeHandleStyle }} />

      {data.hasVisibleChildren && typeof data.onMinimizeChildren === 'function' && (
        <button
          type="button"
          className="fn-minimize-children nodrag nopan"
          onClick={event => {
            event.stopPropagation();
            data.onMinimizeChildren(data.id);
          }}
          title="Collapse all child branches"
          aria-label="Collapse all child branches"
          style={isVerticalLayout ? { bottom: '-10px', left: '19px' } : { right: '-10px', top: '19px' }}
        >
          −
        </button>
      )}

      {data.collapsedChildCount > 0 && (
        <button
          className="nodrag nopan"
          onClick={event => {
            event.stopPropagation();
            data.onRestoreChildren?.(data.id);
          }}
          title="Restore collapsed child branches"
          style={{
            position: 'absolute', zIndex: 12,
            ...(isVerticalLayout
              ? { bottom: '-12px', left: data.hasVisibleChildren ? '45px' : '16px' }
              : { right: '-12px', top: data.hasVisibleChildren ? '45px' : '16px' }),
            minWidth: '24px', height: '24px', padding: '0 5px', borderRadius: '12px',
            border: '1px solid #60a5fa', background: '#1e3a8a', color: '#fff',
            cursor: 'pointer', fontSize: '11px', fontWeight: 700,
          }}
        >
          +{data.collapsedChildCount}
        </button>
      )}

      <div className="fn-header" style={{ borderBottom: `1px solid ${finalBorderColor}` }}>
        <div>
          <div className="fn-name">{data.name}</div>
          <div className="fn-path" style={{ color: fileColor }}>{shortPath}</div>
        </div>
        <div className="pill-container">
          {diffStatus === 'added' && <span className="pill" style={{ background: '#22c55e', color: '#fff' }}>NEW</span>}
          {diffStatus === 'removed' && <span className="pill" style={{ background: '#ef4444', color: '#fff' }}>REMOVED</span>}
          {diffStatus === 'changed' && <span className="pill" style={{ background: '#f59e0b', color: '#000' }}>CHANGED</span>}
          {data.isCycleReference && <span className="pill" style={{ background: '#7c2d12', color: '#fff' }}>CYCLE</span>}
          {isExternal && <span className="pill" style={{ background: '#475569', color: '#fff' }}>EXTERNAL</span>}
          {isExternal && additionalOverloadCount > 0 && (
            <span className="pill" style={{ background: '#334155', color: '#e2e8f0' }}>
              +{additionalOverloadCount} {additionalOverloadCount === 1 ? 'overload' : 'overloads'}
            </span>
          )}
          {data.isEntryPoint && <span className="pill entry">entry</span>}
          {data.isAsync && <span className="pill async">async</span>}
        </div>
      </div>

      <div className="fn-params" title={signature || paramsList}>
        {signatureParams
          ? (signatureParams.length > 72 ? signatureParams.substring(0, 72) + '...' : signatureParams)
          : `(${paramsList.length > 50 ? paramsList.substring(0, 50) + '...' : paramsList})`}
      </div>

      {displayReturnType && data.kind !== 'component' && (
        <div className="fn-return" title={displayReturnType}>
          <span style={{ opacity: 0.6 }}>→</span> {displayReturnType.length > 30 ? displayReturnType.substring(0, 30) + '...' : displayReturnType}
        </div>
      )}

      {data.documentation?.text && (
        <section
          className="fn-documentation nodrag nopan"
          onClick={event => event.stopPropagation()}
        >
          <div className="fn-documentation-text">
            <JsDocDocumentation text={data.documentation.text} />
          </div>
        </section>
      )}

      {Array.isArray(data.sourceDiffRows) ? (
        <div
          className="fn-source fn-source-diff nodrag nopan"
          style={{ fontSize: `${data.codeFontSize || 12}px` }}
          onClick={event => event.stopPropagation()}
        >
          {data.sourceDiffRows.map((row: any, index: number) => (
            <div className={`fn-diff-row fn-diff-row--${row.kind}`} key={`${index}:${row.oldLine || ''}:${row.newLine || ''}`}>
              <span className="fn-diff-line-number">{row.oldLine || ''}</span>
              <span className="fn-diff-line-number">{row.newLine || ''}</span>
              <span className="fn-diff-marker">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</span>
              <span className="fn-diff-code-cell">
                {row.kind === 'context' && (Array.isArray(data.callHighlights) ? data.callHighlights : [])
                  .filter((highlight: { line: number }) => highlight.line === row.sourceLine)
                  .map((highlight: { line: number; column: number; length: number }) => (
                    <span
                      key={`${highlight.line}:${highlight.column}:${highlight.length}`}
                      className="fn-source-call-token"
                      style={{ top: 0, left: `calc(5px + ${highlight.column}ch)`, width: `${highlight.length}ch` }}
                      aria-hidden="true"
                    />
                  ))}
                <code className="hljs" dangerouslySetInnerHTML={{ __html: row.html }} />
              </span>
            </div>
          ))}
        </div>
      ) : typeof data.codeHtml === 'string' && (
        <pre
          className="fn-source"
          style={{ fontSize: `${data.codeFontSize || 12}px` }}
          onClick={event => event.stopPropagation()}
        >
          <span className="fn-source-line-numbers" aria-hidden="true">
            {Array.from({ length: data.sourceLineCount || 0 }, (_, index) => (
              <span key={index}>{(data.sourceStartLine || 1) + index}</span>
            ))}
          </span>
          {(Array.isArray(data.callHighlights) ? data.callHighlights : []).map((highlight: { line: number; column: number; length: number }) => (
            <span
              key={`${highlight.line}:${highlight.column}:${highlight.length}`}
              className="fn-source-call-token"
              style={{
                top: `calc(10px + ${highlight.line} * 1.5em)`,
                left: `calc(54px + ${highlight.column}ch)`,
                width: `${highlight.length}ch`,
              }}
              aria-hidden="true"
            />
          ))}
          <code className="hljs" dangerouslySetInnerHTML={{ __html: data.codeHtml }} />
        </pre>
      )}

      <Handle type="source" position={isVerticalLayout ? Position.Bottom : Position.Right} style={{ background: '#38bdf8', border: 'none', width: '8px', height: '8px', ...treeHandleStyle }} />
    </div>
  );
}

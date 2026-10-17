import React, { useState } from 'react';
import { FiCopy, FiCheck, FiCode } from './Icons';

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{
      margin: '0.75rem 0',
      borderRadius: 'calc(var(--radius) - 2px)',
      overflow: 'hidden',
      border: '1px solid var(--border)',
      background: 'var(--muted)'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0.35rem 0.75rem',
        background: 'rgba(0, 0, 0, 0.25)',
        fontSize: '0.72rem',
        color: 'var(--muted-foreground)',
        borderBottom: '1px solid var(--border)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', textTransform: 'lowercase', fontFamily: 'var(--font-mono)' }}>
          <FiCode size={13} style={{ color: 'var(--primary)' }} />
          <span>{language || 'text'}</span>
        </div>
        <button
          onClick={handleCopy}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--muted-foreground)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.3rem',
            fontSize: '0.72rem'
          }}
          title="Copy code"
        >
          {copied ? <FiCheck size={12} style={{ color: 'var(--primary)' }} /> : <FiCopy size={12} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre style={{
        margin: 0,
        padding: '0.85rem 1rem',
        overflowX: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.82rem',
        lineHeight: 1.55,
        color: 'var(--foreground)'
      }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function MarkdownRenderer({ content = '' }) {
  if (!content) return null;

  // Split into tokens: code blocks vs markdown text
  const parts = [];
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', text: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'code', language: match[1], code: match[2].replace(/\n$/, '') });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', text: content.slice(lastIndex) });
  }

  const renderTextSegment = (rawText, keyPrefix) => {
    const lines = rawText.split('\n');
    const elements = [];
    let listItems = [];
    let inList = false;

    const flushList = (idx) => {
      if (listItems.length > 0) {
        elements.push(
          <ul key={`${keyPrefix}-list-${idx}`} style={{ paddingLeft: '1.4rem', margin: '0.4rem 0' }}>
            {listItems.map((item, liIdx) => (
              <li key={liIdx} style={{ marginBottom: '0.2rem', lineHeight: 1.5 }}>
                {renderInline(item)}
              </li>
            ))}
          </ul>
        );
        listItems = [];
        inList = false;
      }
    };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();

      // Heading 1
      if (trimmed.startsWith('# ')) {
        flushList(idx);
        elements.push(
          <h1 key={`${keyPrefix}-h1-${idx}`} style={{ fontSize: '1.25rem', fontWeight: '800', margin: '0.75rem 0 0.35rem 0', borderBottom: '1px solid var(--border)', paddingBottom: '0.25rem' }}>
            {renderInline(trimmed.slice(2))}
          </h1>
        );
        return;
      }

      // Heading 2
      if (trimmed.startsWith('## ')) {
        flushList(idx);
        elements.push(
          <h2 key={`${keyPrefix}-h2-${idx}`} style={{ fontSize: '1.1rem', fontWeight: '700', margin: '0.65rem 0 0.3rem 0', color: 'var(--accent)' }}>
            {renderInline(trimmed.slice(3))}
          </h2>
        );
        return;
      }

      // Heading 3
      if (trimmed.startsWith('### ')) {
        flushList(idx);
        elements.push(
          <h3 key={`${keyPrefix}-h3-${idx}`} style={{ fontSize: '0.98rem', fontWeight: '700', margin: '0.55rem 0 0.25rem 0' }}>
            {renderInline(trimmed.slice(4))}
          </h3>
        );
        return;
      }

      // Blockquote
      if (trimmed.startsWith('> ')) {
        flushList(idx);
        elements.push(
          <blockquote key={`${keyPrefix}-quote-${idx}`} style={{
            margin: '0.5rem 0',
            padding: '0.4rem 0.85rem',
            borderLeft: '3px solid var(--primary)',
            background: 'var(--muted)',
            borderRadius: '0 4px 4px 0',
            fontStyle: 'italic',
            color: 'var(--muted-foreground)'
          }}>
            {renderInline(trimmed.slice(2))}
          </blockquote>
        );
        return;
      }

      // Bullet list item
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        inList = true;
        listItems.push(trimmed.slice(2));
        return;
      }

      // Numbered list item
      if (/^\d+\.\s/.test(trimmed)) {
        inList = true;
        listItems.push(trimmed.replace(/^\d+\.\s/, ''));
        return;
      }

      flushList(idx);

      if (trimmed === '') {
        elements.push(<div key={`${keyPrefix}-blank-${idx}`} style={{ height: '0.4rem' }} />);
      } else {
        elements.push(
          <p key={`${keyPrefix}-p-${idx}`} style={{ margin: '0.25rem 0', lineHeight: 1.6 }}>
            {renderInline(line)}
          </p>
        );
      }
    });

    flushList(lines.length);
    return elements;
  };

  // Inline formatting: `code`, **bold**, *italic*
  const renderInline = (str) => {
    // Regex for inline code, bold, italic
    const parts = [];
    let remaining = str;
    let keyIdx = 0;

    // Pattern matches `code` or **bold** or *italic*
    const inlineRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/;

    while (remaining) {
      const match = inlineRegex.exec(remaining);
      if (!match) {
        parts.push(remaining);
        break;
      }

      const matchStart = match.index;
      if (matchStart > 0) {
        parts.push(remaining.slice(0, matchStart));
      }

      const token = match[0];
      if (token.startsWith('`') && token.endsWith('`')) {
        parts.push(
          <code
            key={keyIdx++}
            className="font-mono"
            style={{
              background: 'rgba(47, 188, 91, 0.12)',
              color: 'var(--accent)',
              border: '1px solid rgba(47, 188, 91, 0.25)',
              padding: '0.1rem 0.35rem',
              borderRadius: '4px',
              fontSize: '0.85em'
            }}
          >
            {token.slice(1, -1)}
          </code>
        );
      } else if (token.startsWith('**') && token.endsWith('**')) {
        parts.push(
          <strong key={keyIdx++} style={{ fontWeight: '700', color: 'var(--foreground)' }}>
            {token.slice(2, -2)}
          </strong>
        );
      } else if (token.startsWith('*') && token.endsWith('*')) {
        parts.push(
          <em key={keyIdx++} style={{ fontStyle: 'italic' }}>
            {token.slice(1, -1)}
          </em>
        );
      }

      remaining = remaining.slice(matchStart + token.length);
    }

    return parts;
  };

  return (
    <div className="markdown-body" style={{ fontSize: '0.88rem', lineHeight: 1.6 }}>
      {parts.map((part, i) => {
        if (part.type === 'code') {
          return <CodeBlock key={i} language={part.language} code={part.code} />;
        }
        return <div key={i}>{renderTextSegment(part.text, `seg-${i}`)}</div>;
      })}
    </div>
  );
}

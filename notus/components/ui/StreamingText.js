// StreamingText — renders markdown with blinking cursor while streaming
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export const StreamingText = ({ text, streaming }) => (
  <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7, color: 'var(--text-primary)' }}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {text || ''}
    </ReactMarkdown>
    {streaming && (
      <span style={{
        display: 'inline-block',
        width: 2,
        height: '1em',
        verticalAlign: '-2px',
        marginLeft: 3,
        background: 'var(--accent)',
        borderRadius: 999,
        boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)',
        animation: 'blink 0.95s step-end infinite',
      }} />
    )}
  </div>
);

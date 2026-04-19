// StreamingText — renders markdown with blinking cursor while streaming
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const StreamingText = ({ text, streaming }) => (
  <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7, color: 'var(--text-primary)' }}>
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {text || ''}
    </ReactMarkdown>
    {streaming && (
      <span style={{
        display: 'inline-block',
        width: 2,
        height: '1em',
        verticalAlign: '-2px',
        marginLeft: 2,
        background: 'var(--accent)',
        animation: 'blink 1s step-end infinite',
      }} />
    )}
  </div>
);

// MarkdownPreview — react-markdown based rendered preview
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';

export const MarkdownPreview = ({ content }) => (
  <div
    className="md-preview"
    style={{
      flex: 1,
      overflow: 'auto',
      padding: '32px 40px',
      fontFamily: 'var(--font-editor)',
      fontSize: 'var(--text-lg)',
      lineHeight: 1.8,
      color: 'var(--text-primary)',
    }}
  >
    <style>{`
      .md-preview h1 { font-size: var(--text-3xl); font-weight: 700; margin: 0 0 16px; line-height: 1.3; }
      .md-preview h2 { font-size: var(--text-2xl); font-weight: 600; margin: 40px 0 12px; }
      .md-preview h3 { font-size: var(--text-xl); font-weight: 600; margin: 32px 0 8px; }
      .md-preview p { margin: 0 0 16px; }
      .md-preview pre { background: var(--bg-secondary); padding: var(--space-4); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: var(--text-sm); line-height: 1.6; overflow: auto; margin: 16px 0 24px; }
      .md-preview code { font-family: var(--font-mono); font-size: 0.9em; background: var(--bg-secondary); padding: 1px 5px; border-radius: 3px; }
      .md-preview pre code { background: none; padding: 0; }
      .md-preview blockquote { border-left: 3px solid var(--accent); padding-left: var(--space-4); color: var(--text-secondary); margin: 20px 0; }
      .md-preview ul, .md-preview ol { padding-left: 22px; margin: 0 0 16px; }
      .md-preview li { margin-bottom: 4px; }
      .md-preview img { max-width: 100%; border-radius: var(--radius-md); box-shadow: var(--shadow-sm); }
      .md-preview table { width: 100%; border-collapse: collapse; margin: 16px 0; }
      .md-preview th, .md-preview td { border: 1px solid var(--border-primary); padding: 8px 12px; font-size: var(--text-sm); }
      .md-preview th { background: var(--bg-secondary); font-weight: 600; }
      .md-preview a { color: var(--accent); text-decoration: underline; }
      .md-preview hr { border: none; border-top: 1px solid var(--border-subtle); margin: 24px 0; }
    `}</style>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeHighlight, rehypeKatex]}>
      {content || ''}
    </ReactMarkdown>
  </div>
);

// StreamingText — renders markdown with blinking cursor while streaming
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import { splitBareUrlLabel } from '../../utils/markdownLinks';
import { parseInternalFileLink, remarkLinkifyAgentFileReferences } from '../../utils/agentFileLinks';

const StreamingMarkdownLink = ({ href, children, onOpenFileLink, ...props }) => {
  const fileId = parseInternalFileLink(href);
  if (fileId && typeof onOpenFileLink === 'function') {
    return <a href={href} {...props} onClick={(event) => {
      event.preventDefault();
      onOpenFileLink(fileId);
    }} aria-label={`在编辑器中打开文件 ${children}`}>{children}</a>;
  }
  const childList = Array.isArray(children) ? children : [children];
  const visibleText = childList.length === 1 && typeof childList[0] === 'string' ? childList[0] : '';
  const split = splitBareUrlLabel(visibleText);
  if (split) {
    return <><a href={split.url} {...props}>{split.url}</a>{split.suffix}</>;
  }
  return <a href={href} {...props}>{children}</a>;
};

export const StreamingText = ({ text, streaming, className = '', style = {}, files = [], onOpenFileLink }) => (
  <div className={className} style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7, color: 'var(--text-primary)', maxWidth: '100%', minWidth: 0, overflow: 'hidden', ...style }}>
    <ReactMarkdown
      components={{ a: (props) => <StreamingMarkdownLink {...props} onOpenFileLink={onOpenFileLink} /> }}
      remarkPlugins={[remarkGfm, remarkMath, [remarkLinkifyAgentFileReferences, { files }]]}
      rehypePlugins={[rehypeHighlight, rehypeKatex]}
      urlTransform={(url) => parseInternalFileLink(url) ? url : defaultUrlTransform(url)}
    >
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

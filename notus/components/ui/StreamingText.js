import { memo, useMemo } from 'react';
import { ProgressiveReveal } from './ProgressiveReveal';
import { websiteLinkProps } from '../../utils/websiteLinks';
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
    return <><a href={split.url} {...props} {...websiteLinkProps(split.url)}>{split.url}</a>{split.suffix}</>;
  }
  return <a href={href} {...props} {...websiteLinkProps(href)}>{children}</a>;
};

const EMPTY_FILES = [];
const MarkdownBody = memo(function MarkdownBody({text, files, onOpenFileLink}) {
  const components = useMemo(() => ({a: props => <StreamingMarkdownLink {...props} onOpenFileLink={onOpenFileLink} />}), [onOpenFileLink]);
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath, [remarkLinkifyAgentFileReferences, {files}]], [files]);
  return <ReactMarkdown components={components} remarkPlugins={remarkPlugins} rehypePlugins={[rehypeHighlight, rehypeKatex]}
    urlTransform={(url) => parseInternalFileLink(url) ? url : defaultUrlTransform(url)}>{text || ''}</ReactMarkdown>;
});

export const StreamingText = memo(function StreamingText({ text, streaming, animate = false, className = '', style = {}, files = EMPTY_FILES, onOpenFileLink }) {
  return <div className={className} style={{fontSize:'var(--text-sm)',lineHeight:1.7,color:'var(--text-primary)',maxWidth:'100%',minWidth:0,overflow:'hidden',...style}}>
    <ProgressiveReveal animate={animate}>
      <MarkdownBody text={text} files={files} onOpenFileLink={onOpenFileLink} />
    </ProgressiveReveal>
    {streaming ? <span aria-hidden="true" className="notus-streaming-cursor" /> : null}
  </div>;
});

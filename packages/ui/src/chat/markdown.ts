// Assistant text is markdown from the model: render it with HTML switched off, so raw tags in the text come out as
// escaped text and never as elements. markdown-it also refuses javascript:, vbscript: and data: links by itself.
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

const defaultLink = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const t = tokens[idx]!;
  t.attrSet('target', '_blank');
  t.attrSet('rel', 'noopener noreferrer');
  return defaultLink(tokens, idx, options, env, self);
};

const cache = new Map<string, string>();

/** Markdown to an HTML string that is safe to inject (no raw HTML passes through). Memoised: items repeat on every delta. */
export function renderMarkdown(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const html = md.render(src);
  if (cache.size > 2000) cache.clear();
  cache.set(src, html);
  return html;
}

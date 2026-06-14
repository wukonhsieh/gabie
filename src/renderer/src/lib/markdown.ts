import { marked } from 'marked'
import DOMPurify from 'dompurify'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Render assistant markdown to HTML that is safe for dangerouslySetInnerHTML.
// `marked` only parses markdown; it does not sanitize, so model- or
// persistence-controlled raw HTML (scripts, event handlers, javascript: URLs)
// would otherwise reach the renderer, which exposes window.api. DOMPurify strips
// anything executable while keeping the safe markdown tag/attribute set. If
// parsing throws, fall back to plain escaped text.
export function renderMarkdown(src: string): string {
  if (!src) return ''
  try {
    const raw = marked.parse(src, { async: false, breaks: true }) as string
    return DOMPurify.sanitize(raw)
  } catch {
    return escapeHtml(src).replace(/\n/g, '<br/>')
  }
}

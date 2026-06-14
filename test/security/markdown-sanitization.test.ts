// @vitest-environment jsdom
import { describe, test, expect } from 'vitest'
import { renderMarkdown } from '../../src/renderer/src/lib/markdown'

// renderMarkdown feeds dangerouslySetInnerHTML in the assistant message branch
// (Message.tsx). The renderer exposes window.api, so assistant/model output and
// persisted conversation content must never produce executable HTML.
describe('renderMarkdown sanitization', () => {
  test('strips <script> tags', () => {
    const html = renderMarkdown('hi <script>window.api.doEvil()</script> there')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toContain('doEvil')
  })

  test('strips inline event handlers', () => {
    const html = renderMarkdown('<img src=x onerror="window.api.doEvil()">')
    expect(html.toLowerCase()).not.toContain('onerror')
    expect(html).not.toContain('doEvil')
  })

  test('removes javascript: URLs from links', () => {
    const html = renderMarkdown('[click](javascript:window.api.doEvil())')
    expect(html.toLowerCase()).not.toContain('javascript:')
    expect(html).not.toContain('doEvil')
  })

  test('drops dangerous embedded elements (iframe/object)', () => {
    const html = renderMarkdown('<iframe src="https://evil.example"></iframe><object data="x"></object>')
    expect(html).not.toMatch(/<iframe/i)
    expect(html).not.toMatch(/<object/i)
  })

  test('neutralizes a persisted malicious message payload', () => {
    // Simulates a conversation reloaded from disk whose content embeds raw HTML.
    const persisted = 'Sure! <a href="javascript:alert(1)">link</a>\n\n<svg onload="alert(2)"></svg>'
    const html = renderMarkdown(persisted)
    expect(html.toLowerCase()).not.toContain('javascript:')
    expect(html.toLowerCase()).not.toContain('onload')
    expect(html).not.toContain('alert(')
  })

  test('keeps safe links with http/https and adds no executable content', () => {
    const html = renderMarkdown('[docs](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toMatch(/>docs</)
  })

  test('keeps code blocks', () => {
    const html = renderMarkdown('```\nconst x = 1\n```')
    expect(html).toMatch(/<pre[\s>]/i)
    expect(html).toMatch(/<code[\s>]/i)
    expect(html).toContain('const x = 1')
  })

  test('keeps inline code and emphasis', () => {
    const html = renderMarkdown('use `npm run build` and **stop** then *go*')
    expect(html).toMatch(/<code[\s>]/i)
    expect(html).toMatch(/<strong[\s>]/i)
    expect(html).toMatch(/<em[\s>]/i)
  })

  test('keeps tables (GFM)', () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |'
    const html = renderMarkdown(md)
    expect(html).toMatch(/<table[\s>]/i)
    expect(html).toMatch(/<td[\s>]/i)
  })

  test('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownContent } from '../src/renderer/App.js'

describe('chat Markdown rendering', () => {
  it('renders headings, GFM tables, lists, code, and links as structured markup', () => {
    const html = renderToStaticMarkup(<MarkdownContent content={`## 检查结论

| 项目 | 状态 |
| --- | --- |
| 缓存 | 安全 |

- 第一项
- 第二项

\`inline\`

\`\`\`powershell
Get-Process
\`\`\`

[官方说明](https://example.com/docs)`} />)

    expect(html).toContain('<h2>检查结论</h2>')
    expect(html).toContain('<table>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<code class="language-powershell">Get-Process')
    expect(html).toContain('href="https://example.com/docs"')
  })
})

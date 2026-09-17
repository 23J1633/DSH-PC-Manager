interface ConnectionOptions {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  timeoutMs?: number
}

function chatCompletionsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Base URL 仅支持 HTTP 或 HTTPS')
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`.replace(/^\/\//, '/')
  url.search = ''
  url.hash = ''
  return url
}

function responseMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  const error = typeof entry.error === 'object' && entry.error !== null ? entry.error as Record<string, unknown> : undefined
  if (typeof error?.message === 'string') return error.message
  return typeof entry.message === 'string' ? entry.message : undefined
}

export async function testModelConnection(options: ConnectionOptions): Promise<string> {
  const model = options.model.trim()
  const apiKey = options.apiKey.trim()
  if (model.length === 0) throw new Error('模型 ID 不能为空')
  if (apiKey.length === 0) throw new Error('API Key 不能为空')
  const endpoint = chatCompletionsUrl(options.baseUrl)
  const startedAt = performance.now()
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('模型连接测试超过 12 秒，请检查网络、Base URL 或代理设置')
    }
    throw new Error(`无法连接模型服务：${error instanceof Error ? error.message : String(error)}`)
  }

  const body = await response.text()
  let parsed: unknown
  try {
    parsed = body.length === 0 ? {} : JSON.parse(body)
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const fallback = body.trim().slice(0, 300) || response.statusText
    const detail = responseMessage(parsed) ?? fallback
    throw new Error(`模型服务返回 ${response.status}：${detail}`)
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).choices)) {
    throw new Error('模型服务响应成功，但格式不是兼容的 Chat Completions 结果')
  }
  const elapsed = Math.max(1, Math.round(performance.now() - startedAt))
  const provider = options.provider.trim() || 'DeepSeek'
  return `${provider} · ${model} 连接正常（${elapsed} ms）`
}

export { chatCompletionsUrl }

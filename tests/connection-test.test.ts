import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { chatCompletionsUrl, testModelConnection } from '../src/main/connection-test.js'

describe('fast model connection test', () => {
  const servers: ReturnType<typeof createServer>[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => { resolve() }) })))
  })

  it('normalizes base URLs without duplicating the endpoint', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com').toString()).toBe('https://api.deepseek.com/chat/completions')
    expect(chatCompletionsUrl('https://example.test/v1/').toString()).toBe('https://example.test/v1/chat/completions')
    expect(chatCompletionsUrl('https://example.test/v1/chat/completions').toString()).toBe('https://example.test/v1/chat/completions')
  })

  it('performs one short Chat Completions request', async () => {
    let requestPath = ''
    let body = ''
    const server = createServer((request, response) => {
      requestPath = request.url ?? ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }))
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Test server did not bind')
    const result = await testModelConnection({
      provider: 'test-provider',
      model: 'test-model',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      timeoutMs: 2_000,
    })
    expect(requestPath).toBe('/v1/chat/completions')
    expect(JSON.parse(body)).toMatchObject({ model: 'test-model', max_tokens: 1, stream: false })
    expect(result).toContain('连接正常')
  })

  it('aborts a stalled request at the configured timeout', async () => {
    const server = createServer((_request, _response) => {})
    servers.push(server)
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Test server did not bind')
    const startedAt = Date.now()
    await expect(testModelConnection({
      provider: 'test-provider',
      model: 'test-model',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      timeoutMs: 80,
    })).rejects.toThrow('超过 12 秒')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})

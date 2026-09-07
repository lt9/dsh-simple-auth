import { Readable } from 'node:stream'

export async function readRequestBody(req, max = 16 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > max) return { error: 'too-large' }
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks)
  const replay = Readable.from(body.length ? [body] : [])
  for (const key of [
    'method',
    'url',
    'headers',
    'httpVersion',
    'rawHeaders',
    'rawTrailers',
    'trailers',
    'socket',
    'aborted',
    'complete'
  ]) {
    if (key in req) replay[key] = req[key]
  }
  return { body, req: replay }
}

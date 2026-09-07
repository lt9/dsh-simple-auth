/**
 * Filter server→client WebSocket frames by session ACL.
 * Installed on the raw socket before the ws handshake completes.
 */
export function installWsFilter(socket, transformFrame) {
  const origWrite = socket.write.bind(socket)
  let buf = Buffer.alloc(0)

  socket.write = function filteredWrite(chunk, encoding, cb) {
    if (!chunk) return origWrite(chunk, encoding, cb)
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
    buf = Buffer.concat([buf, piece])
    const out = []
    while (buf.length >= 2) {
      const parsed = takeServerFrame(buf)
      if (!parsed) break
      buf = parsed.rest
      if (!parsed.raw) continue
      if (parsed.opcode !== 0x01) {
        out.push(parsed.raw)
        continue
      }
      try {
        const text = parsed.payload.toString('utf8')
        const obj = JSON.parse(text)
        const next = transformFrame(obj)
        if (!next) continue
        out.push(next === obj ? parsed.raw : encodeServerTextFrame(JSON.stringify(next)))
      } catch {
        out.push(parsed.raw)
      }
    }
    if (!out.length) {
      if (typeof encoding === 'function') encoding()
      else if (typeof cb === 'function') cb()
      return true
    }
    const merged = Buffer.concat(out)
    return origWrite(merged, encoding, cb)
  }

  socket.write.__simpleAuthFilter = true
  return () => {
    if (socket.write.__simpleAuthFilter) socket.write = origWrite
  }
}

function encodeServerTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  if (len < 126) {
    return Buffer.concat([Buffer.from([0x81, len]), payload])
  }
  if (len < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(len), 2)
  return Buffer.concat([header, payload])
}

function takeServerFrame(buf) {
  const b0 = buf[0]
  const b1 = buf[1]
  if (b0 === undefined || b1 === undefined) return null
  const opcode = b0 & 0x0f
  let offset = 2
  let len = b1 & 0x7f
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { raw: buf, payload: Buffer.alloc(0), rest: Buffer.alloc(0), opcode }
    len = Number(big)
    offset = 10
  }
  const total = offset + len
  if (buf.length < total) return null
  const raw = buf.subarray(0, total)
  const payload = len ? buf.subarray(offset, total) : Buffer.alloc(0)
  return { raw, payload, rest: buf.subarray(total), opcode }
}

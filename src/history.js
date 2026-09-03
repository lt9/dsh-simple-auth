function eventOf(item) {
  if (!item || typeof item !== 'object') return item
  return item.event && typeof item.event === 'object' ? item.event : item
}

function closedKey(event) {
  const data = event && event.data
  if (!data || typeof data !== 'object') return ''
  if (data.turn === undefined || data.step === undefined) return ''
  return `${data.turn}:${data.step}`
}

/** Drop assistant/chunk rows whose message already has a closing assistant/message (dsh #4678). */
export function filterClosedChunks(items) {
  if (!Array.isArray(items) || items.length === 0) return items
  const closed = new Set()
  for (const item of items) {
    const event = eventOf(item)
    if (event && event.type === 'assistant/message') {
      const key = closedKey(event)
      if (key) closed.add(key)
    }
  }
  if (closed.size === 0) return items
  return items.filter((item) => {
    const event = eventOf(item)
    if (!event || event.type !== 'assistant/chunk') return true
    const key = closedKey(event)
    return !key || !closed.has(key)
  })
}

function patchValue(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.events)) return value
  const events = filterClosedChunks(value.events)
  if (events === value.events) return value
  return { ...value, events }
}

/** Walk a unary RPC envelope (or a batch of them) and elide closed chunks in history pages. */
export function elideHistoryPayload(payload) {
  if (Array.isArray(payload)) return payload.map(elideHistoryPayload)
  if (!payload || typeof payload !== 'object') return payload
  if (payload.result && payload.result.ok && payload.result.value) {
    const value = patchValue(payload.result.value)
    if (value === payload.result.value) return payload
    return { ...payload, result: { ...payload.result, value } }
  }
  if (Array.isArray(payload.events)) {
    return patchValue(payload)
  }
  return payload
}

export const TEXT_WINDOW_CHARS = 800
export const TEXT_MIN_NGRAM = 20
export const TEXT_MAX_NGRAM = 120
export const TEXT_REPEAT_THRESHOLD = 4

/**
 * Returns true when the tail of `buf` contains an n-gram that repeats
 * TEXT_REPEAT_THRESHOLD times back-to-back — the canonical sign that a
 * local quantized model has entered a text repetition loop.
 *
 * Checks n-gram lengths on a ×1.5 scale from minNgramLen to maxNgramLen,
 * and tries several phase offsets per length so mis-aligned repeats are
 * caught too.  Only activates once `buf` is at least twice `windowChars`
 * to avoid false positives on short, legitimately repetitive answers.
 */
export function detectTextRepetition(
  buf: string,
  windowChars = TEXT_WINDOW_CHARS,
  minNgramLen = TEXT_MIN_NGRAM,
  maxNgramLen = TEXT_MAX_NGRAM,
  repeatThreshold = TEXT_REPEAT_THRESHOLD
): boolean {
  if (buf.length < windowChars) return false
  const tail = buf.slice(-windowChars)
  for (let k = minNgramLen; k <= maxNgramLen; k = Math.ceil(k * 1.5)) {
    const needed = k * repeatThreshold
    if (needed > tail.length) break
    const step = Math.max(1, Math.floor(k / 4))
    for (let off = 0; off < k; off += step) {
      if (off + needed > tail.length) continue
      const seg = tail.slice(off, off + needed)
      const base = seg.slice(0, k)
      let ok = true
      for (let i = 1; i < repeatThreshold; i++) {
        if (seg.slice(i * k, (i + 1) * k) !== base) {
          ok = false
          break
        }
      }
      if (ok) return true
    }
  }
  return false
}

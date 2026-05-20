export const TEXT_WINDOW_CHARS = 800
export const TEXT_MIN_PERIOD = 20
export const TEXT_MAX_PERIOD = 300
export const TEXT_REPEAT_THRESHOLD = 3

/**
 * Returns true when the tail of `buf` ends with a repeated block —
 * the canonical sign that a local quantized model has entered a
 * text repetition loop.
 *
 * For each candidate period length p (minPeriod..maxPeriod), checks
 * whether the last p*repeatThreshold characters consist of the same
 * p-char block repeated repeatThreshold times.  End-anchored checking
 * catches alternating two-variant cycles (A B A B …) whose combined
 * period is 2p, as well as single-variant loops.
 *
 * Only activates once buf.length >= windowChars to avoid false positives
 * on short responses.
 */
export function detectTextRepetition(
  buf: string,
  windowChars = TEXT_WINDOW_CHARS,
  minPeriod = TEXT_MIN_PERIOD,
  maxPeriod = TEXT_MAX_PERIOD,
  repeatThreshold = TEXT_REPEAT_THRESHOLD
): boolean {
  if (buf.length < windowChars) return false
  const tail = buf.slice(-windowChars)
  for (let p = minPeriod; p <= maxPeriod; p++) {
    const needed = p * repeatThreshold
    if (needed > tail.length) break
    const block = tail.slice(-p)
    let ok = true
    for (let i = 1; i < repeatThreshold; i++) {
      if (tail.slice(tail.length - p * (i + 1), tail.length - p * i) !== block) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

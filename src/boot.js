const MARKER = 'data-dsh-simple-auth-boot'

export function bootScript(minTimeoutMs) {
  const min = Math.max(0, Number(minTimeoutMs) || 0)
  return `<script ${MARKER}>
(function () {
  var min = ${min};
  if (min > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    var orig = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = function (ms) {
      var n = Number(ms);
      if (!Number.isFinite(n) || n < 1) n = min;
      return orig(Math.max(n, min));
    };
  }
})();
</script>`
}

export function injectBoot(html, minTimeoutMs) {
  if (typeof html !== 'string' || html.includes(MARKER)) return html
  const tag = bootScript(minTimeoutMs)
  const lower = html.toLowerCase()
  const i = lower.indexOf('<head>')
  if (i >= 0) return html.slice(0, i + 6) + tag + html.slice(i + 6)
  return tag + html
}

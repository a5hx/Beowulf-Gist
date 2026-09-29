/** Mirrors apps/extension/src/serp/reader.ts, as plain ES5 source so it can run inside page.evaluate. */
export const COUNT_ORGANIC_SRC = `function (cfg) {
  var c = Array.prototype.slice.call(document.querySelectorAll(cfg.result));
  return c.filter(function (el) {
    if (c.some(function (o) { return o !== el && el.contains(o); })) return false;
    if (cfg.exclude.some(function (s) { return el.closest(s); })) return false;
    var t = el.querySelector(cfg.title);
    var a = t && t.closest('a[href]');
    if (!a) return false;
    return !/(^|\\.)google\\./.test(new URL(a.getAttribute('href'), 'https://www.google.com/').hostname);
  }).length;
}`;

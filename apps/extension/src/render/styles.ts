export const BADGE_CSS = `
:host { all: initial; display: inline-block; vertical-align: middle; margin-left: 6px; font: 12px/1.4 system-ui, sans-serif; position: relative; z-index: 5; }
.wrap { display: inline-flex; align-items: center; gap: 4px; position: relative; }
.badge { all: unset; cursor: pointer; width: 18px; height: 18px; border-radius: 50%; display: inline-grid; place-items: center; font-weight: 700; font-size: 11px; color: #fff; background: #6b7280; }
.badge:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
.badge.conf-high { background: #374151; }
.badge.conf-none { background: #9ca3af; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #16a34a; }
.tag { padding: 0 6px; border-radius: 8px; font-size: 11px; background: #fef3c7; color: #92400e; }
.tag-dim, .tag-collapse { background: #fee2e2; color: #991b1b; }
.card { position: absolute; top: 24px; left: 0; width: 280px; padding: 12px; border-radius: 10px; background: #fff; color: #111827; box-shadow: 0 8px 24px rgba(0,0,0,.18); border: 1px solid #e5e7eb; }
.card[hidden] { display: none; }
.head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.grade { font-size: 22px; font-weight: 700; }
.verdict { font-weight: 600; }
.low { font-size: 10px; padding: 0 5px; border-radius: 6px; background: #e5e7eb; color: #374151; }
.note { font-size: 11px; color: #4b5563; margin-bottom: 6px; }
.row { display: grid; grid-template-columns: 110px 1fr 28px; align-items: center; gap: 6px; margin: 3px 0; }
.bar { height: 6px; border-radius: 3px; background: #e5e7eb; overflow: hidden; }
.fill { display: block; height: 100%; background: #2563eb; }
.num { text-align: right; color: #6b7280; }
.na { color: #9ca3af; }
details { margin-top: 8px; } summary { cursor: pointer; color: #2563eb; }
ul { margin: 6px 0 0; padding-left: 16px; } li { margin: 2px 0; }
.flags { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
.flags button { all: unset; cursor: pointer; padding: 2px 8px; border: 1px solid #d1d5db; border-radius: 6px; }
.flags button:focus-visible { outline: 2px solid #2563eb; }
@media (prefers-color-scheme: dark) {
  .card { background: #1f2937; color: #f9fafb; border-color: #374151; }
  .bar { background: #374151; } .flags button { border-color: #4b5563; }
}`;

export const BAR_CSS = `
:host { all: initial; display: block; font: 13px/1.5 system-ui, sans-serif; }
.bar { padding: 6px 10px; margin: 4px 0 12px; border-radius: 8px; background: #f3f4f6; color: #4b5563; }
button { all: unset; cursor: pointer; color: #2563eb; }
button:focus-visible { outline: 2px solid #2563eb; }
@media (prefers-color-scheme: dark) { .bar { background: #1f2937; color: #d1d5db; } }`;

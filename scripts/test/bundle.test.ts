import { describe, expect, it } from 'vitest';
import { buildBundle } from '../lib/bundle';

const selectors = { version: 1, result: '#rso div.g', title: 'h3', exclude: [] };
const farm = { match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 10, reasons: ['r'], source: 'seed' };
const human = { match: 'cook.org', matchLevel: 'domain', kind: 'human', siteBehavior: 90, reasons: ['r'], source: 'seed' };

describe('buildBundle', () => {
  it('merges files, sorts entries and derives a stable content version', () => {
    const a = buildBundle([{ name: 'humans.json', data: [human] }, { name: 'farms.json', data: [farm] }], selectors);
    const b = buildBundle([{ name: 'farms.json', data: [farm] }, { name: 'humans.json', data: [human] }], selectors);
    expect(a.domains.map((d) => d.match)).toEqual(['cook.org', 'farm.com']);
    expect(a.version).toMatch(/^[0-9a-f]{12}$/);
    expect(a.version).toBe(b.version);
  });
  it('changes version when content changes', () => {
    const a = buildBundle([{ name: 'f.json', data: [farm] }], selectors);
    const b = buildBundle([{ name: 'f.json', data: [{ ...farm, siteBehavior: 11 }] }], selectors);
    expect(a.version).not.toBe(b.version);
  });
  it('rejects duplicates across files with both file names in the message', () => {
    expect(() => buildBundle([{ name: 'a.json', data: [farm] }, { name: 'b.json', data: [farm] }], selectors)).toThrow(/b\.json.*domain:farm\.com.*a\.json/);
  });
  it('reports which file and field is invalid', () => {
    expect(() => buildBundle([{ name: 'farms.json', data: [{ ...farm, siteBehavior: 500 }] }], selectors)).toThrow(/farms\.json: 0\.siteBehavior/);
  });
  it('rejects invalid selectors', () => {
    expect(() => buildBundle([], { version: 0, result: '', title: 'h3', exclude: [] })).toThrow();
  });
});

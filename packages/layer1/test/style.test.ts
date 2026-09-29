import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/dom';
import { scoreStyle } from '../src/style';
import { blogRecipe, farmRecipe, nonNativeHowTo } from './fixtures';

describe('scoreStyle', () => {
  it('farm: stock phrases and uniform rhythm hit the -5 floor', () => {
    expect(scoreStyle(buildContext(farmRecipe())).adjust).toBe(-5);
  });
  it('real blog: no adjustment', () => {
    expect(scoreStyle(buildContext(blogRecipe())).adjust).toBe(0);
  });
  it('never goes below -5 or above 0', () => {
    const a = scoreStyle(buildContext(nonNativeHowTo())).adjust;
    expect(a).toBeGreaterThanOrEqual(-5);
    expect(a).toBeLessThanOrEqual(0);
  });
});

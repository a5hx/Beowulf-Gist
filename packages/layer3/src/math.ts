export const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
/** Linear 0–100 score: `zeroAt` maps to 0 and `fullAt` maps to 100. */
export const lerpScore = (value: number, zeroAt: number, fullAt: number) => clamp(Math.round(((value - zeroAt) / (fullAt - zeroAt)) * 100));

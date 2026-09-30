import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env';

describe('readEnv', () => {
  it('requires DATABASE_URL and BOT_INFO_URL', () => {
    expect(() => readEnv({})).toThrow(/DATABASE_URL/);
    expect(() => readEnv({ DATABASE_URL: 'postgres://x' })).toThrow(/BOT_INFO_URL/);
  });
  it('applies defaults', () => {
    expect(readEnv({ DATABASE_URL: 'postgres://x', BOT_INFO_URL: 'https://gist.example/bot' })).toEqual({
      databaseUrl: 'postgres://x', port: 8787, botInfoUrl: 'https://gist.example/bot', clientIpHeader: undefined,
    });
  });
});

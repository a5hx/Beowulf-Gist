import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}

/** Runs every migration file in order. Files are written to be idempotent (IF NOT EXISTS). */
export async function migrate(sql: Sql): Promise<void> {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await sql.unsafe(readFileSync(join(dir, file), 'utf8'));
  }
}

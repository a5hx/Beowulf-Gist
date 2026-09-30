import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { connect, migrate, type Sql } from '../../src/db';

export async function startDb(): Promise<{ sql: Sql; stop: () => Promise<void> }> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const sql = connect(container.getConnectionUri());
  await migrate(sql);
  return {
    sql,
    stop: async () => {
      await sql.end();
      await container.stop();
    },
  };
}

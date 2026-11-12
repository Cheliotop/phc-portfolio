import { execute } from './db';
import { migration_0001_init } from './migrations/0001_init';

export async function runMigrations() {
  await execute(migration_0001_init);
}

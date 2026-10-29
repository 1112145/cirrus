import {
  columnFields,
  columnSql,
  createIndexSql,
  createIndexesSql,
  createTableSql,
  dropIndexSql,
  dropTableSql,
  indexKind,
} from './ddl.ts';
import { isConstantDefault } from './defaults.ts';
import { quoteIdent } from './identifiers.ts';
import type { TableDef } from './types.ts';

export type Plan = {
  /** Run in order inside one D1 batch, so the change is atomic. */
  statements: string[];
  /** The table is copied into a new one; slow on large tables (spec §7.2). */
  requiresRebuild: boolean;
};

/** Name of the temporary table during a rebuild. The cirrus_ prefix keeps it clear of user collections. */
export const REBUILD_PREFIX = 'cirrus_rebuild_';

export const planCreateTable = (table: TableDef): string[] => [createTableSql(table), ...createIndexesSql(table)];

export const planDropTable = (name: string): string[] => [dropTableSql(name)];

/**
 * Plan the DDL that turns `current` into `desired` (same table, fields matched by name).
 *
 * In place when SQLite allows it: ADD COLUMN, DROP COLUMN, CREATE/DROP INDEX. Anything that changes
 * an existing column (type, nullability, default) needs the standard SQLite table rebuild.
 */
export function planTableChange(current: TableDef, desired: TableDef): Plan {
  if (current.name !== desired.name) throw new Error(`Can't rename table "${current.name}" to "${desired.name}"`);

  const before = new Map(columnFields(current).map((f) => [f.field, f]));
  const after = new Map(columnFields(desired).map((f) => [f.field, f]));
  const added = [...after.values()].filter((f) => !before.has(f.field));
  const removed = [...before.values()].filter((f) => !after.has(f.field));
  const kept = [...after.values()].filter((f) => before.has(f.field));

  const requiresRebuild =
    kept.some((f) => columnSql(f) !== columnSql(before.get(f.field)!)) ||
    // ADD COLUMN can't add a primary key or use a non-constant default on a non-empty table
    added.some((f) => f.column.primaryKey || !isConstantDefault(f.type, f.column.defaultValue)) ||
    removed.some((f) => f.column.primaryKey);

  if (requiresRebuild) {
    return { statements: rebuildSql(desired, kept.map((f) => f.field)), requiresRebuild };
  }

  const table = quoteIdent(desired.name);
  const statements: string[] = [];

  // Indexes first: SQLite can't drop an indexed column.
  for (const f of before.values()) {
    const from = indexKind(f);
    const to = after.has(f.field) ? indexKind(after.get(f.field)!) : null;
    if (from && from !== to) statements.push(dropIndexSql(desired.name, f.field, from));
  }
  for (const f of removed) statements.push(`ALTER TABLE ${table} DROP COLUMN ${quoteIdent(f.field)}`);
  // A NOT NULL column without a default fails here if the table has rows (CONTAINS_NULL_VALUES).
  for (const f of added) statements.push(`ALTER TABLE ${table} ADD COLUMN ${columnSql(f)}`);
  for (const f of after.values()) {
    const from = before.has(f.field) ? indexKind(before.get(f.field)!) : null;
    const to = indexKind(f);
    if (to && to !== from) statements.push(createIndexSql(desired.name, f.field, to));
  }

  return { statements, requiresRebuild };
}

/**
 * The SQLite table rebuild (https://www.sqlite.org/lang_altertable.html#otheralter): create the new
 * table, copy the kept columns, swap, recreate indexes. STRICT makes the copy fail loudly on values
 * the new type can't hold, instead of silently converting them.
 * M4: once tables have foreign keys, run with PRAGMA defer_foreign_keys = ON.
 */
function rebuildSql(desired: TableDef, copied: string[]): string[] {
  const tmp = quoteIdent(REBUILD_PREFIX + desired.name);
  const table = quoteIdent(desired.name);
  const cols = copied.map(quoteIdent).join(', ');
  return [
    createTableSql(desired, REBUILD_PREFIX + desired.name),
    `INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${table}`,
    dropTableSql(desired.name),
    `ALTER TABLE ${tmp} RENAME TO ${table}`,
    ...createIndexesSql(desired),
  ];
}

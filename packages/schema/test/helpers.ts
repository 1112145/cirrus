import { DatabaseSync } from 'node:sqlite';
import type { ColumnDef, FieldDef, FieldType, TableDef } from '../src/index.ts';

export const col = (over: Partial<ColumnDef> = {}): ColumnDef => ({
  primaryKey: false,
  autoIncrement: false,
  nullable: true,
  unique: false,
  indexed: false,
  defaultValue: null,
  maxLength: null,
  numericPrecision: null,
  numericScale: null,
  ...over,
});

export const field = (name: string, type: FieldType, over: Partial<ColumnDef> = {}): FieldDef => ({
  field: name,
  type,
  column: type === 'alias' ? null : col(over),
});

export const uuidPk = field('id', 'uuid', { primaryKey: true, nullable: false });

export const table = (name: string, ...fields: FieldDef[]): TableDef => ({ name, fields });

/** Real SQLite (node:sqlite), so generated DDL is executed and not just compared as text. */
export function sqlite() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    /** Run statements atomically, like a D1 batch. */
    run(statements: string[]) {
      db.exec('BEGIN');
      try {
        for (const s of statements) db.exec(s);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    rows: (sql: string, ...params: Array<string | number | null>) =>
      db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
    columns: (t: string) => (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).map((c) => c.name),
    indexes: (t: string) =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
          .all(t) as Array<{ name: string }>
      ).map((r) => r.name),
  };
}

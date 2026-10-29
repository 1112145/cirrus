import type { RequestContext } from '../request.ts';
import type { CollectionRecord } from '../schema/store.ts';
import { permissionsFor } from './permissions.ts';

/**
 * Which fields of a collection the request may read, for /collections and /fields: 'all' for
 * admins and '*' permissions, the union of the read permissions' fields otherwise, and null
 * without read permission (or for folders, which only admins see).
 */
export function readableFields(req: RequestContext, col: CollectionRecord): 'all' | Set<string> | null {
  if (req.accountability.admin) return 'all';
  if (col.folder) return null;
  const rules = permissionsFor(req.schema, req.accountability, col.collection, 'read');
  if (rules.length === 0) return null;
  const fields = new Set(rules.flatMap((r) => r.fields ?? []));
  return fields.has('*') ? 'all' : fields;
}

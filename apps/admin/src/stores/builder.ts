import { createCollection, createField, createRelation, deleteCollection, deleteField, deleteRelation } from '@directus/sdk';
import { request } from '../api.ts';
import type { Step } from '../lib/builder.ts';
import type { FieldType } from '../lib/schema.ts';
import { fieldOf, loadSchema, primaryKeyOf } from './schema.ts';

/** Runs data model plans (lib/builder.ts) against the API, then reloads the data model. */

function run(step: Step) {
  switch (step.op) {
    case 'createCollection':
      return request(createCollection(step.payload));
    case 'createField':
      return request(createField(step.collection, step.payload));
    case 'createRelation':
      return request(createRelation(step.payload));
  }
}

function undo(step: Step) {
  const p = step.payload as { collection: string; field: string };
  switch (step.op) {
    case 'createCollection':
      return request(deleteCollection(p.collection));
    case 'createField':
      return request(deleteField(step.collection, p.field));
    case 'createRelation':
      return request(deleteRelation(p.collection, p.field));
  }
}

/**
 * Run the steps in order. Each is its own request, so when one fails the ones before it are
 * undone (newest first), leaving the data model as it was.
 */
export async function runPlan(steps: Step[]): Promise<void> {
  const done: Step[] = [];
  try {
    for (const step of steps) {
      await run(step);
      done.push(step);
    }
  } catch (e) {
    for (const step of done.reverse()) await undo(step).catch(() => {});
    throw e;
  } finally {
    await loadSchema();
  }
}

/** The type of a collection's primary key (directus_users and directus_files have UUIDs). */
export const keyType = (collection: string): FieldType => (collection.startsWith('directus_') ? 'uuid' : (fieldOf(collection, primaryKeyOf(collection))?.type ?? 'uuid'));

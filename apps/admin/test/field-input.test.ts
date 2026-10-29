import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import FieldInput from '../src/components/FieldInput.vue';
import type { Field } from '../src/lib/schema.ts';

const field = (type: Field['type'], meta: Partial<NonNullable<Field['meta']>> = {}): Field => ({
  collection: 'posts',
  field: 'x',
  type,
  meta: { special: null, interface: null, options: null, display: null, readonly: false, hidden: false, sort: null, width: 'full', note: null, required: false, group: null, validation: null, searchable: true, ...meta },
  schema: null,
});

describe('FieldInput', () => {
  it('emits typed values, and an error for text the type cannot take', async () => {
    const w = mount(FieldInput, { props: { field: field('integer'), modelValue: 1 } });
    const input = w.get('input');
    expect(input.element.value).toBe('1');
    await input.setValue('42');
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual([42]);
    expect(w.emitted('input-error')!.at(-1)).toEqual([null]);
    await input.setValue('4.5');
    expect(w.emitted('input-error')!.at(-1)).toEqual(['Enter a whole number.']);
    // What was typed stays, even though the value didn't change.
    expect(input.element.value).toBe('4.5');
  });

  it('offers the choices of a dropdown', async () => {
    const choices = [
      { text: 'Draft', value: 'draft' },
      { text: 'Published', value: 'published' },
    ];
    const w = mount(FieldInput, { props: { field: field('string', { interface: 'select-dropdown', options: { choices } }), modelValue: 'draft' } });
    expect(w.findAll('option').map((o) => o.text())).toEqual(['—', 'Draft', 'Published']);
    await w.get('select').setValue('published');
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual(['published']);
    await w.get('select').setValue('');
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual([null]);
  });

  it('toggles booleans and parses JSON', async () => {
    const toggle = mount(FieldInput, { props: { field: field('boolean'), modelValue: null } });
    expect(toggle.text()).toContain('Not set');
    await toggle.get('input').setValue(true);
    expect(toggle.emitted('update:modelValue')!.at(-1)).toEqual([true]);

    const json = mount(FieldInput, { props: { field: field('json'), modelValue: { a: 1 } } });
    await json.get('textarea').setValue('{"b": [2]}');
    expect(json.emitted('update:modelValue')!.at(-1)).toEqual([{ b: [2] }]);
  });

  it('updates the text when the value changes from outside', async () => {
    const w = mount(FieldInput, { props: { field: field('string'), modelValue: 'a' } });
    await w.setProps({ modelValue: 'b' });
    expect(w.get('input').element.value).toBe('b');
  });
});

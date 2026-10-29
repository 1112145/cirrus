import { reactive } from 'vue';
import { errorMessage } from '../lib/errors.ts';

/** Short-lived messages in the corner: saves, deletes, errors. */

export type Notice = { id: number; kind: 'success' | 'error' | 'info'; message: string };

export const notices = reactive<Notice[]>([]);

let next = 1;

export function notify(message: string, kind: Notice['kind'] = 'success') {
  const id = next++;
  notices.push({ id, kind, message });
  // A burst of saves shouldn't fill the screen.
  if (notices.length > 4) notices.splice(0, notices.length - 4);
  setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000);
}

export const notifyError = (e: unknown) => notify(errorMessage(e), 'error');

export function dismiss(id: number) {
  const i = notices.findIndex((n) => n.id === id);
  if (i >= 0) notices.splice(i, 1);
}

/** A confirmation dialog, answered by ConfirmHost. */
export const confirmation = reactive<{ open: boolean; message: string; action: string; danger: boolean; resolve: ((ok: boolean) => void) | null }>({
  open: false,
  message: '',
  action: 'OK',
  danger: false,
  resolve: null,
});

export function confirm(message: string, opts: { action?: string; danger?: boolean } = {}): Promise<boolean> {
  confirmation.resolve?.(false);
  return new Promise((resolve) => {
    Object.assign(confirmation, { open: true, message, action: opts.action ?? 'OK', danger: opts.danger ?? false, resolve });
  });
}

export function answer(ok: boolean) {
  const resolve = confirmation.resolve;
  Object.assign(confirmation, { open: false, resolve: null });
  resolve?.(ok);
}

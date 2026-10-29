export const PORT = Number(process.env.E2E_PORT ?? 8788);
export const BASE = `http://localhost:${PORT}`;
export const TOKEN = process.env.E2E_ADMIN_TOKEN ?? 'e2e-admin-token';
export const ADMIN = { email: 'admin@example.com', password: 'e2e-admin-password' };

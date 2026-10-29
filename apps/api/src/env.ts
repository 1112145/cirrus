export type Bindings = {
  DB: D1Database;
  PROJECT_NAME: string;
  DEFAULT_LANGUAGE: string;
  /** Static admin token (a Wrangler secret) until users and auth land in M3. Unset = no admin access. */
  ADMIN_TOKEN?: string;
};

/** Who is making the request. M3 adds the user, role and policies. */
export type Accountability = { admin: boolean };

export type AppEnv = { Bindings: Bindings; Variables: { accountability: Accountability } };

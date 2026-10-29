export type Bindings = {
  DB: D1Database;
  PROJECT_NAME: string;
  DEFAULT_LANGUAGE: string;
  /** Static admin token (a Wrangler secret) until users and auth land in M3. Unset = no admin access. */
  ADMIN_TOKEN?: string;
  /** Items returned when a request sets no limit (Directus QUERY_LIMIT_DEFAULT). Default 100. */
  QUERY_LIMIT_DEFAULT?: string;
  /** Largest limit a request may ask for; -1 = none (Directus QUERY_LIMIT_MAX). With a maximum, limit=-1 returns that many. */
  QUERY_LIMIT_MAX?: string;
};

/** Who is making the request. M3 adds the user, role and policies. */
export type Accountability = { admin: boolean };

export type AppEnv = { Bindings: Bindings; Variables: { accountability: Accountability } };

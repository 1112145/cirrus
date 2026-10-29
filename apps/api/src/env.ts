export type Bindings = {
  DB: D1Database;
  /** The R2 bucket holding the files' contents (spec §11). Without it, uploads and assets answer SERVICE_UNAVAILABLE. */
  STORAGE?: R2Bucket;
  /** Cloudflare Images, for asset transformations (`/assets/:id?width=…`). Optional: without it, they're refused. */
  IMAGES?: ImagesBinding;
  PROJECT_NAME: string;
  DEFAULT_LANGUAGE: string;
  /**
   * Static admin token (a Wrangler secret), sent like a Directus static token. Optional: it creates
   * the first users and stays as a way back in; unset = no such token (ADR-013).
   */
  ADMIN_TOKEN?: string;
  /** Signs access tokens (HS256; a Wrangler secret). Without it nobody can log in (Directus SECRET). */
  SECRET?: string;
  /** Access token lifetime, e.g. "15m" (Directus ACCESS_TOKEN_TTL). */
  ACCESS_TOKEN_TTL?: string;
  /** Refresh token lifetime, e.g. "7d" (Directus REFRESH_TOKEN_TTL). */
  REFRESH_TOKEN_TTL?: string;
  /** Mark the refresh token cookie Secure: "true" / "false" (Directus REFRESH_TOKEN_COOKIE_SECURE). */
  REFRESH_TOKEN_COOKIE_SECURE?: string;
  /** SameSite of the refresh token cookie: lax, strict or none (Directus REFRESH_TOKEN_COOKIE_SAME_SITE). */
  REFRESH_TOKEN_COOKIE_SAME_SITE?: string;
  /** Domain of the refresh token cookie (Directus REFRESH_TOKEN_COOKIE_DOMAIN). */
  REFRESH_TOKEN_COOKIE_DOMAIN?: string;
  /** Items returned when a request sets no limit (Directus QUERY_LIMIT_DEFAULT). Default 100. */
  QUERY_LIMIT_DEFAULT?: string;
  /** Largest limit a request may ask for; -1 = none (Directus QUERY_LIMIT_MAX). With a maximum, limit=-1 returns that many. */
  QUERY_LIMIT_MAX?: string;
  /** Most segments a path into relations may have in a query (Directus MAX_RELATIONAL_DEPTH; at least 2). Default 10. */
  MAX_RELATIONAL_DEPTH?: string;
  /** Largest upload, e.g. "100mb" (Directus FILES_MAX_UPLOAD_SIZE). Default: none (the plan's request size limit applies). */
  FILES_MAX_UPLOAD_SIZE?: string;
  /** MIME types uploads may have, comma-separated patterns (Directus FILES_MIME_TYPE_ALLOW_LIST). Default "*\/*". */
  FILES_MIME_TYPE_ALLOW_LIST?: string;
  /** Exif tags kept in files' metadata, comma-separated `<section>.<tag>` (Directus FILE_METADATA_ALLOW_LIST). */
  FILE_METADATA_ALLOW_LIST?: string;
  /** How long clients may cache assets, e.g. "30d" (Directus ASSETS_CACHE_TTL). Default 30 days. */
  ASSETS_CACHE_TTL?: string;
  /** Most operations in an asset's `transforms` (Directus ASSETS_TRANSFORM_MAX_OPERATIONS). Default 5. */
  ASSETS_TRANSFORM_MAX_OPERATIONS?: string;
  /** Largest width or height of an image that may be transformed (Directus ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION). Default 6000. */
  ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION?: string;
};

/** The credential a request presented, before policies are looked up. */
export type Identity =
  | { kind: 'public' }
  /** ADMIN_TOKEN: admin, without a user. */
  | { kind: 'admin-token' }
  | { kind: 'user'; user: string; role: string | null };

/** Who is making the request and what applies to them (Directus accountability). */
export type Accountability = {
  /** A policy with admin_access applies (or ADMIN_TOKEN): no permission checks. */
  admin: boolean;
  /** A policy with app_access (or admin) applies. */
  app: boolean;
  user: string | null;
  role: string | null;
  /** The role and its ancestors, top-level first ($CURRENT_ROLES). */
  roles: string[];
  /** The policies that apply, in priority order ($CURRENT_POLICIES). */
  policies: string[];
  ip: string | null;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    identity: Identity;
    /** Memoized by requestContext(). */
    request?: Promise<import('./request.ts').RequestContext>;
  };
};

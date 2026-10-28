export type Bindings = {
  DB: D1Database;
  PROJECT_NAME: string;
  DEFAULT_LANGUAGE: string;
};

export type AppEnv = { Bindings: Bindings };

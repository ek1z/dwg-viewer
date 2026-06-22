declare module '*.css';

interface ImportMetaEnv {
  /** App base path, injected by Vite (trailing slash, e.g. `/dwg-viewer/`). */
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Isomorphic exports: safe to import from the browser, Next.js and Node services.

export const LANGUAGES = ["javascript", "python"] as const;

export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

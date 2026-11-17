// Node-only helpers. Never import this from browser code.
import { existsSync } from "node:fs";

/**
 * Loads a .env file if it exists. Variables already present in process.env win,
 * so platform-provided env (Fly, Vercel, CI) always overrides the local file.
 */
export function loadEnvFileIfExists(file: string | URL): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

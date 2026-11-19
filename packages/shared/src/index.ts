// Isomorphic exports: safe to import from the browser, Next.js and Node services.
import { z } from "zod";

export const LANGUAGES = ["javascript", "python"] as const;

export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/** Room ids are nanoid(10): URL-safe alphabet, fixed length. */
export const ROOM_ID_LENGTH = 10;
export const roomIdSchema = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${ROOM_ID_LENGTH}}$`));

export const createRoomSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80, "Name is too long"),
  language: z.enum(LANGUAGES),
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>;

// ---------------------------------------------------------------------------
// Code execution (web -> runner contract)
// ---------------------------------------------------------------------------

export const RUN_LIMITS = {
  /** Wall-clock limit; the container is killed when it is reached. */
  timeoutMs: 5_000,
  /** Largest program accepted, in UTF-8 bytes. */
  codeBytes: 100 * 1024,
  /** Largest stdin accepted, in UTF-8 bytes. */
  stdinBytes: 64 * 1024,
  /** Output kept per stream (stdout, stderr); the program is killed if it writes more. */
  outputBytes: 64 * 1024,
  memoryBytes: 128 * 1024 * 1024,
  cpus: 0.5,
  pids: 64,
  tmpfsMegabytes: 16,
} as const;

/** What the browser sends to POST /api/run (the language comes from the room). */
export const runRequestSchema = z.object({
  roomId: roomIdSchema,
  code: z.string(),
  stdin: z.string().optional(),
});

/** What the web app sends to the runner (signed). */
export const runnerRequestSchema = z.object({
  userId: z.string().min(1),
  language: z.enum(LANGUAGES),
  code: z.string(),
  stdin: z.string().default(""),
});

export type RunnerRequest = z.infer<typeof runnerRequestSchema>;

export interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  /** Killed for exceeding the memory limit. */
  oom_killed: boolean;
  /** Output hit the per-stream cap and the program was stopped. */
  output_truncated: boolean;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

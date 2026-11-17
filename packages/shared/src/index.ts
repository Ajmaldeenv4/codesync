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

import { connection } from "next/server";
import { auth } from "@/auth";

export interface CurrentUser {
  id: string;
  name: string;
  image: string | null;
}

/** The signed-in user, narrowed to what the app needs, or null. Reads the request cookies. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  // Auth.js uses crypto randomness before it reads cookies. Mark this as request-time work
  // first so Cache Components doesn't treat that randomness as part of a prerender.
  await connection();
  const session = await auth();
  const user = session?.user;
  if (!user?.id) return null;
  return { id: user.id, name: user.name ?? user.email ?? "Anonymous", image: user.image ?? null };
}

/** Only same-origin relative paths are allowed as post-sign-in redirects. */
export function safeCallbackPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\")) return "/";
  return value;
}

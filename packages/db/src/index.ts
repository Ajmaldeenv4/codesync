import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";

const globalForPrisma = globalThis as unknown as { codesyncPrisma?: PrismaClient };

/**
 * Lazily creates one PrismaClient per process (reused across Next.js dev hot reloads).
 * Lazy so that importing this module never requires DATABASE_URL (e.g. during `next build`).
 */
export function getPrisma(): PrismaClient {
  if (!globalForPrisma.codesyncPrisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForPrisma.codesyncPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
    });
  }
  return globalForPrisma.codesyncPrisma;
}

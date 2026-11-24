import { PrismaAdapter } from "@auth/prisma-adapter";
import { getPrisma, type PrismaClient } from "@codesync/db";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { isTestAuthEnabled, normaliseTestUserName, testUserEmail } from "@/lib/test-auth";

function testProvider() {
  return Credentials({
    id: "test",
    name: "Test user",
    credentials: { name: { label: "Name", type: "text" } },
    async authorize(credentials) {
      const name = normaliseTestUserName(credentials?.name);
      if (!name) return null;
      const email = testUserEmail(name);
      const user = await getPrisma().user.upsert({
        where: { email },
        update: { name },
        create: { email, name },
      });
      return { id: user.id, name: user.name, email: user.email, image: user.image };
    },
  });
}

/**
 * Defers creating the Prisma client until the adapter first touches it, so importing this
 * module (e.g. during `next build`) never needs DATABASE_URL. NextAuth's own lazy-config form
 * would also do that, but it makes `auth(handler)` return a Promise, which proxy.ts can't export.
 */
function lazyPrisma(): Parameters<typeof PrismaAdapter>[0] {
  const deferred = new Proxy({} as PrismaClient, {
    get(_target, prop) {
      const client = getPrisma();
      const value: unknown = Reflect.get(client, prop);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
  // The adapter's PrismaClient type points at the default @prisma/client output;
  // ours is generated into @codesync/db, which is the same client at runtime.
  return deferred as unknown as Parameters<typeof PrismaAdapter>[0];
}

// GitHub is only used to sign in, so its tokens are dropped instead of stored with the account.
const providers: NextAuthConfig["providers"] = [GitHub({ account: () => ({}) })];
if (isTestAuthEnabled(process.env)) providers.push(testProvider());

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(lazyPrisma()),
  // JWT sessions (users still live in Postgres via the adapter). Credentials requires it.
  session: { strategy: "jwt" },
  providers,
  callbacks: {
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});

export const testAuthEnabled = () => isTestAuthEnabled(process.env);

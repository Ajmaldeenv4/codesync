import { getPrisma } from "@codesync/db";
import Link from "next/link";
import { Suspense } from "react";
import { testAuthEnabled } from "@/auth";
import { LanguageBadge } from "@/components/language-badge";
import { listRecentRooms } from "@/lib/rooms";
import { getCurrentUser, safeCallbackPath, type CurrentUser } from "@/lib/session";
import { signInAsTestUser, signInWithGitHub, signOutAction } from "./actions";
import { NewRoomForm } from "./new-room-form";

export default function Home(props: PageProps<"/">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-4xl font-semibold tracking-tight">CodeSync</h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Edit code together in real time, then run it in a sandbox.
        </p>
      </header>
      {/* Everything below reads the session, so it streams in behind this boundary. */}
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <HomeContent searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}

async function HomeContent({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams]);
  if (!user) {
    return (
      <SignInPanel
        callbackUrl={safeCallbackPath(params.callbackUrl)}
        testMode={testAuthEnabled()}
      />
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <UserBar user={user} />
      <NewRoomForm />
      <RecentRooms userId={user.id} />
    </div>
  );
}

function SignInPanel({ callbackUrl, testMode }: { callbackUrl: string; testMode: boolean }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">Sign in to create or join a room</h2>
      <form action={signInWithGitHub}>
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Sign in with GitHub
        </button>
      </form>
      {testMode && (
        <form
          action={signInAsTestUser}
          className="flex flex-wrap items-end gap-2"
          data-testid="test-sign-in"
        >
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Test user (AUTH_TEST_MODE)</span>
            <input
              name="name"
              required
              placeholder="Ada"
              className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
            />
          </label>
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Sign in as test user
          </button>
        </form>
      )}
    </section>
  );
}

function UserBar({ user }: { user: CurrentUser }) {
  return (
    <div className="flex items-center gap-3">
      {user.image ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote GitHub avatars
        <img src={user.image} alt="" className="size-8 rounded-full" />
      ) : null}
      <p className="text-sm">
        Signed in as <span className="font-medium">{user.name}</span>
      </p>
      <form action={signOutAction} className="ml-auto">
        <button type="submit" className="text-sm text-zinc-600 underline dark:text-zinc-400">
          Sign out
        </button>
      </form>
    </div>
  );
}

async function RecentRooms({ userId }: { userId: string }) {
  const rooms = await listRecentRooms(getPrisma(), userId);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Recent rooms</h2>
      {rooms.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No rooms yet. Create one above or open a shared link.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {rooms.map((room) => (
            <li key={room.id}>
              <Link
                href={`/room/${room.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <span className="font-medium">{room.name}</span>
                <LanguageBadge language={room.language} />
                <span className="ml-auto text-xs text-zinc-500">
                  {room.ownerId === userId ? "Owner" : "Member"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

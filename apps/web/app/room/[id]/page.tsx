import { getPrisma } from "@codesync/db";
import { roomIdSchema } from "@codesync/shared";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { getRoom, joinRoom } from "@/lib/rooms";
import { getCurrentUser } from "@/lib/session";
import { RoomView } from "./room-view";

export default function RoomPage(props: PageProps<"/room/[id]">) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-zinc-500">Opening room…</div>
      }
    >
      <Room params={props.params} />
    </Suspense>
  );
}

async function Room({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!roomIdSchema.safeParse(id).success) notFound();

  const user = await getCurrentUser();
  if (!user) redirect(`/?callbackUrl=${encodeURIComponent(`/room/${id}`)}`);

  const db = getPrisma();
  const room = await getRoom(db, id);
  if (!room) notFound();

  // Anyone signed in with the link may join; this records the membership.
  await joinRoom(db, room.id, user.id);

  return (
    <RoomView
      room={{
        id: room.id,
        name: room.name,
        language: room.language,
        isOwner: room.ownerId === user.id,
      }}
      user={{ name: user.name, image: user.image }}
    />
  );
}

// Mints the short-lived token the browser presents to the collab server's WebSocket.
import { getPrisma } from "@codesync/db";
import { roomIdSchema } from "@codesync/shared";
import { ROOM_TOKEN_TTL_SECONDS, signRoomToken } from "@codesync/shared/token";
import { isMember } from "@/lib/rooms";
import { getCurrentUser } from "@/lib/session";

const noStore = { "cache-control": "no-store" };

export async function GET(_request: Request, ctx: RouteContext<"/api/rooms/[id]/token">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!roomIdSchema.safeParse(id).success) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (!(await isMember(getPrisma(), id, user.id))) {
    return Response.json({ error: "not_a_member" }, { status: 403 });
  }

  const secret = process.env.WS_TOKEN_SECRET;
  if (!secret) {
    console.error("WS_TOKEN_SECRET is not set");
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const token = await signRoomToken(
    { sub: user.id, roomId: id, name: user.name, avatar: user.image },
    secret,
  );
  return Response.json({ token, expiresIn: ROOM_TOKEN_TTL_SECONDS }, { headers: noStore });
}

import { getPrisma } from "@codesync/db";
import { createRoomSchema } from "@codesync/shared";
import { z } from "zod";
import { createRoom, listRecentRooms, RoomLimitError } from "@/lib/rooms";
import { getCurrentUser } from "@/lib/session";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = createRoomSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body", issues: z.flattenError(parsed.error).fieldErrors },
      { status: 400 },
    );
  }

  try {
    const room = await createRoom(getPrisma(), user.id, parsed.data);
    return Response.json({ room }, { status: 201 });
  } catch (err) {
    if (err instanceof RoomLimitError) return Response.json({ error: err.code }, { status: 429 });
    throw err;
  }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const rooms = await listRecentRooms(getPrisma(), user.id);
  return Response.json({ rooms });
}

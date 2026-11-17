// Runs against the real Postgres from DATABASE_URL (docker compose locally, a service in CI).
import { getPrisma, type PrismaClient } from "@codesync/db";
import { roomIdSchema } from "@codesync/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createRoom, getRoom, isMember, joinRoom, listRecentRooms } from "./rooms";

describe.skipIf(!process.env.DATABASE_URL)("rooms data layer", () => {
  let db: PrismaClient;
  const run = randomUUID().slice(0, 8);
  let ownerId = "";
  let guestId = "";

  beforeAll(async () => {
    db = getPrisma();
    const owner = await db.user.create({
      data: { name: "Owner", email: `owner-${run}@vitest.codesync.invalid` },
    });
    const guest = await db.user.create({
      data: { name: "Guest", email: `guest-${run}@vitest.codesync.invalid` },
    });
    ownerId = owner.id;
    guestId = guest.id;
  });

  afterAll(async () => {
    // Rooms and memberships cascade from users.
    await db.user.deleteMany({ where: { id: { in: [ownerId, guestId] } } });
    await db.$disconnect();
  });

  test("createRoom assigns a nanoid id and makes the owner a member", async () => {
    const room = await createRoom(db, ownerId, { name: "Pairing", language: "python" });
    expect(roomIdSchema.safeParse(room.id).success).toBe(true);
    expect(room).toMatchObject({ name: "Pairing", language: "python", ownerId });
    expect(await isMember(db, room.id, ownerId)).toBe(true);
    expect(await isMember(db, room.id, guestId)).toBe(false);
    expect(await getRoom(db, room.id)).toMatchObject({ id: room.id, name: "Pairing" });
  });

  test("getRoom returns null for an unknown id", async () => {
    expect(await getRoom(db, "nosuchroom")).toBeNull();
  });

  test("joinRoom adds a member once and bumps lastSeenAt on repeat visits", async () => {
    const room = await createRoom(db, ownerId, { name: "Shared", language: "javascript" });

    await joinRoom(db, room.id, guestId);
    const first = await db.roomMember.findUniqueOrThrow({
      where: { roomId_userId: { roomId: room.id, userId: guestId } },
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    await joinRoom(db, room.id, guestId);
    const members = await db.roomMember.findMany({ where: { roomId: room.id } });
    const again = members.find((m) => m.userId === guestId);

    expect(members).toHaveLength(2);
    expect(again?.joinedAt).toEqual(first.joinedAt);
    expect(again?.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
  });

  test("listRecentRooms returns only the user's rooms, most recent first", async () => {
    const older = await createRoom(db, guestId, { name: "Older", language: "python" });
    const newer = await createRoom(db, guestId, { name: "Newer", language: "python" });
    await joinRoom(db, newer.id, guestId);

    const rooms = await listRecentRooms(db, guestId);
    const ids = rooms.map((r) => r.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    for (const room of rooms) expect(await isMember(db, room.id, guestId)).toBe(true);

    const ownerRooms = await listRecentRooms(db, ownerId);
    expect(ownerRooms.map((r) => r.id)).not.toContain(older.id);
  });
});

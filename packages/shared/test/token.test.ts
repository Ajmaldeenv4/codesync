import { afterEach, describe, expect, test, vi } from "vitest";
import { signRoomToken, verifyRoomToken, type RoomTokenClaims } from "../src/token";

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const claims: RoomTokenClaims = {
  sub: "user_1",
  roomId: "room123456",
  name: "Ada",
  avatar: "https://example.com/a.png",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("room tokens", () => {
  test("a signed token verifies for its room and returns the claims", async () => {
    const token = await signRoomToken(claims, SECRET);
    expect(await verifyRoomToken(token, SECRET, claims.roomId)).toEqual({ ok: true, claims });
  });

  test("a null avatar round-trips", async () => {
    const token = await signRoomToken({ ...claims, avatar: null }, SECRET);
    const result = await verifyRoomToken(token, SECRET, claims.roomId);
    expect(result).toEqual({ ok: true, claims: { ...claims, avatar: null } });
  });

  test("a token for another room is rejected", async () => {
    const token = await signRoomToken(claims, SECRET);
    expect(await verifyRoomToken(token, SECRET, "otherroom1")).toEqual({
      ok: false,
      reason: "wrong_room",
    });
  });

  test("an expired token is rejected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await signRoomToken(claims, SECRET, 60);
    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    expect(await verifyRoomToken(token, SECRET, claims.roomId)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("a token signed with a different secret is rejected", async () => {
    const token = await signRoomToken(claims, SECRET);
    const other = "another-secret-that-is-also-32-characters-plus";
    expect(await verifyRoomToken(token, other, claims.roomId)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("a tampered token is rejected", async () => {
    const token = await signRoomToken(claims, SECRET);
    const [header, payload = "", signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: "x" }),
    ).toString("base64url");
    expect(
      await verifyRoomToken(`${header}.${forged}.${signature}`, SECRET, claims.roomId),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  test("garbage is rejected", async () => {
    expect(await verifyRoomToken("not-a-jwt", SECRET, claims.roomId)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("short secrets are refused", async () => {
    await expect(signRoomToken(claims, "too-short")).rejects.toThrow(/at least 32/);
  });
});

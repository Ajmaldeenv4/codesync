import { describe, expect, test } from "vitest";
import { createRoomSchema, roomIdSchema } from "../src/index";

describe("createRoomSchema", () => {
  test("accepts a valid room and trims the name", () => {
    expect(createRoomSchema.parse({ name: "  Pairing  ", language: "python" })).toEqual({
      name: "Pairing",
      language: "python",
    });
  });

  test("rejects blank names, long names and unknown languages", () => {
    expect(createRoomSchema.safeParse({ name: "   ", language: "python" }).success).toBe(false);
    expect(createRoomSchema.safeParse({ name: "x".repeat(81), language: "python" }).success).toBe(
      false,
    );
    expect(createRoomSchema.safeParse({ name: "ok", language: "ruby" }).success).toBe(false);
  });
});

describe("roomIdSchema", () => {
  test("accepts nanoid(10)-shaped ids only", () => {
    expect(roomIdSchema.safeParse("V1StGXR8_Z").success).toBe(true);
    expect(roomIdSchema.safeParse("short").success).toBe(false);
    expect(roomIdSchema.safeParse("has space!").success).toBe(false);
    expect(roomIdSchema.safeParse("../etc/pas").success).toBe(false);
  });
});

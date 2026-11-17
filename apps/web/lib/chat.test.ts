import { describe, expect, test } from "vitest";
import { parseChat } from "./chat";

const valid = (id: string, text = "hi") => ({ id, userId: "u1", name: "Ada", text, ts: 1 });

describe("parseChat", () => {
  test("drops malformed entries", () => {
    const items = [valid("message-1"), { id: "x" }, "string", null, valid("message-2", "   ")];
    expect(parseChat(items).map((m) => m.id)).toEqual(["message-1"]);
  });

  test("keeps only the newest `limit` entries", () => {
    const items = Array.from({ length: 5 }, (_, i) => valid(`message-${i}`));
    expect(parseChat(items, 2).map((m) => m.id)).toEqual(["message-3", "message-4"]);
  });
});

import { describe, expect, test } from "vitest";
import { colorForUser, escapeCssString, readPresence, remoteCursorCss } from "./presence";

describe("colorForUser", () => {
  test("is stable per user and a hex colour", () => {
    expect(colorForUser("user_1")).toBe(colorForUser("user_1"));
    expect(colorForUser("user_1")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("readPresence", () => {
  test("keeps clients with a valid user and drops the rest", () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { id: "u1", name: "Ada", color: "#112233", avatar: null } }],
      [2, { cursor: {} }],
      [3, { user: { name: "no id" } }],
    ]);
    expect(readPresence(states)).toEqual([
      { clientId: 1, user: { id: "u1", name: "Ada", color: "#112233", avatar: null } },
    ]);
  });

  test("replaces a colour that isn't plain hex", () => {
    const states = new Map([[1, { user: { id: "u1", name: "Ada", color: "red;}body{x" } }]]);
    expect(readPresence(states)[0]?.user.color).toBe(colorForUser("u1"));
  });
});

describe("remote cursor CSS", () => {
  test("styles remote clients only", () => {
    const presence = [
      { clientId: 7, user: { id: "u1", name: "Ada", color: "#112233", avatar: null } },
      { clientId: 9, user: { id: "u2", name: "Me", color: "#445566", avatar: null } },
    ];
    const css = remoteCursorCss(presence, 9);
    expect(css).toContain('.yRemoteSelectionHead-7::after{content:"Ada"');
    expect(css).not.toContain("-9");
  });

  test("names cannot break out of the CSS string or the style element", () => {
    const hostile = 'x"}</style><script>alert(1)</script>';
    expect(escapeCssString(hostile)).not.toMatch(/["<>]/);
    const css = remoteCursorCss(
      [{ clientId: 1, user: { id: "u", name: hostile, color: "#000000", avatar: null } }],
      2,
    );
    expect(css).not.toContain("</style>");
  });
});

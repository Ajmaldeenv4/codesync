import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __codesyncText?: () => string;
  }
}

test("the owner previews an earlier version and restores it", async ({ page }) => {
  const run = Date.now().toString(36);
  await page.goto("/");
  const form = page.getByTestId("test-sign-in");
  await form.getByRole("textbox").fill(`Owner ${run}`);
  await form.getByRole("button", { name: "Sign in as test user" }).click();

  await page.getByPlaceholder("Interview prep").fill(`History ${run}`);
  await page.getByRole("button", { name: "Create room" }).click();
  await page.waitForURL(/\/room\/[A-Za-z0-9_-]{10}$/);
  const roomUrl = page.url();
  const roomId = roomUrl.split("/").pop() as string;
  const docText = () => page.evaluate(() => window.__codesyncText?.() ?? null);
  const connected = page.getByTestId("connection-status");

  // Version 1: write, then leave so the collab server snapshots the room.
  await expect(connected).toHaveAttribute("data-status", "connected");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.type("const version = 1;");
  await expect.poll(docText).toBe("const version = 1;");
  await page.goto("/");
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/rooms/${roomId}/history`);
      return ((await res.json()) as { versions: unknown[] }).versions.length;
    })
    .toBeGreaterThan(0);

  // Back in the room: the code survived, and we change it.
  await page.goto(roomUrl);
  await expect(connected).toHaveAttribute("data-status", "connected");
  await expect.poll(docText).toBe("const version = 1;");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("const version = 2;");
  await expect.poll(docText).toBe("const version = 2;");

  // Preview version 1 read-only, then restore it.
  await page.getByRole("button", { name: "History" }).click();
  await page.getByTestId("history-version-1").click();
  await expect(page.getByTestId("history-preview")).toContainText("const version = 1;");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Restore this version" }).click();
  await expect(page.getByText("Restored.")).toBeVisible();
  await expect.poll(docText).toBe("const version = 1;");
});

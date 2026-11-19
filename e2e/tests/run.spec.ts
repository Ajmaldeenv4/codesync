import { expect, test } from "@playwright/test";

test("running code shows its output, and runaway code times out", async ({ page, request }) => {
  // The runner answers /health immediately but only accepts runs once its images are pulled.
  await expect
    .poll(
      async () => {
        const res = await request.get("http://localhost:4000/health");
        return ((await res.json()) as { ready: boolean }).ready;
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  const run = Date.now().toString(36);
  await page.goto("/");
  const form = page.getByTestId("test-sign-in");
  await form.getByRole("textbox").fill(`Runner ${run}`);
  await form.getByRole("button", { name: "Sign in as test user" }).click();
  await page.getByPlaceholder("Interview prep").fill(`Run ${run}`);
  await page.getByRole("button", { name: "Create room" }).click();
  await page.waitForURL(/\/room\/[A-Za-z0-9_-]{10}$/);
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");

  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.type("console.log(6 * 7)");
  await page.getByRole("button", { name: "Run ▶" }).click();

  await expect(page.getByTestId("run-stdout")).toHaveText("42", { timeout: 30_000 });
  await expect(page.getByTestId("run-meta")).toContainText("exit 0");

  // Replace the code with an infinite loop; the sandbox kills it at 5 s.
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("for (;;) {}");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("run-meta")).toContainText("Timed out", { timeout: 30_000 });
});

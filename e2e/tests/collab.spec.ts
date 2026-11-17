import { expect, test, type Browser, type Page } from "@playwright/test";

declare global {
  interface Window {
    /** Exposed by the room page outside production: the shared document text. */
    __codesyncText?: () => string;
  }
}

async function newUserPage(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  const form = page.getByTestId("test-sign-in");
  await form.getByRole("textbox").fill(name);
  await form.getByRole("button", { name: "Sign in as test user" }).click();
  await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
  return page;
}

const docText = (page: Page) => page.evaluate(() => window.__codesyncText?.() ?? null);

/** Label text of every remote cursor y-monaco renders (our CSS puts the name in ::after). */
const remoteCursorLabels = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".yRemoteSelectionHead")].map((el) =>
      getComputedStyle(el, "::after").content.replace(/^"|"$/g, ""),
    ),
  );

async function waitUntilConnected(page: Page) {
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
  await expect(page.locator(".monaco-editor .view-lines")).toBeVisible();
}

async function focusEditor(page: Page) {
  await page.locator(".monaco-editor .view-lines").click();
}

test("two users edit one room concurrently, converge, and see each other's cursors", async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const aliceName = `Alice ${run}`;
  const bobName = `Bob ${run}`;
  const alice = await newUserPage(browser, aliceName);
  const bob = await newUserPage(browser, bobName);

  // Alice creates a room; Bob opens the share link.
  await alice.getByPlaceholder("Interview prep").fill(`E2E ${run}`);
  await alice.getByRole("button", { name: "Create room" }).click();
  await alice.waitForURL(/\/room\/[A-Za-z0-9_-]{10}$/);
  await bob.goto(alice.url());
  await waitUntilConnected(alice);
  await waitUntilConnected(bob);

  // A single edit propagates.
  await focusEditor(alice);
  await alice.keyboard.type("const a = 1;");
  await expect.poll(() => docText(bob)).toBe("const a = 1;");

  // Both type at the same time, at opposite ends of the document.
  await focusEditor(bob);
  await Promise.all([
    (async () => {
      await alice.keyboard.press("Control+Home");
      await alice.keyboard.type("// alice was here");
      await alice.keyboard.press("Escape");
      await alice.keyboard.press("Enter");
    })(),
    (async () => {
      await bob.keyboard.press("Control+End");
      await bob.keyboard.press("Enter");
      await bob.keyboard.type("const b = 2;");
    })(),
  ]);

  const expected = "// alice was here\nconst a = 1;\nconst b = 2;";
  await expect.poll(() => docText(alice)).toBe(expected);
  await expect.poll(() => docText(bob)).toBe(expected);

  // Each browser renders the other's cursor with their name.
  await expect.poll(() => remoteCursorLabels(alice)).toContain(bobName);
  await expect.poll(() => remoteCursorLabels(bob)).toContain(aliceName);

  // And lists them as online.
  await expect(
    alice.locator('[data-testid=member-list] li[data-online="true"]', { hasText: bobName }),
  ).toBeVisible();
  await expect(
    bob.locator('[data-testid=member-list] li[data-online="true"]', { hasText: aliceName }),
  ).toBeVisible();

  // When Bob leaves, Alice sees him go offline.
  await bob.context().close();
  await expect(
    alice.locator('[data-testid=member-list] li[data-online="false"]', { hasText: bobName }),
  ).toBeVisible();

  await alice.context().close();
});

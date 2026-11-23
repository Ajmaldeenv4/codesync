import { expect, test, type Browser, type Page } from "@playwright/test";
import gifenc from "gifenc";
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;
const VIEW = { width: 900, height: 520 };
const SCALE = 0.75;
const GAP = 6;

async function openUser(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: SCALE,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  await page.goto("/");
  const form = page.getByTestId("test-sign-in");
  await form.getByRole("textbox").fill(name);
  await form.getByRole("button", { name: "Sign in as test user" }).click();
  await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
  return page;
}

/** Puts both browsers side by side in one RGBA image. */
function sideBySide(left: PNG, right: PNG): PNG {
  const image = new PNG({ width: left.width + GAP + right.width, height: left.height });
  image.data.fill(90);
  PNG.bitblt(left, image, 0, 0, left.width, left.height, 0, 0);
  PNG.bitblt(right, image, 0, 0, right.width, right.height, left.width + GAP, 0);
  return image;
}

test("record two people editing and running code", async ({ browser, request }) => {
  await expect
    .poll(
      async () => {
        const res = await request.get("http://localhost:4000/health");
        return ((await res.json()) as { ready: boolean }).ready;
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  const ada = await openUser(browser, "Ada");
  const grace = await openUser(browser, "Grace");
  await ada.getByPlaceholder("Interview prep").fill("Pairing");
  await ada.locator("select[name=language]").selectOption("python");
  await ada.getByRole("button", { name: "Create room" }).click();
  await ada.waitForURL(/\/room\/[A-Za-z0-9_-]{10}$/);
  await grace.goto(ada.url());
  for (const page of [ada, grace]) {
    await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
    await page.locator(".monaco-editor .view-lines").waitFor();
    // Hide the Next.js dev badge and completion popups: they aren't part of the app.
    await page.addStyleTag({
      content: "nextjs-portal, .suggest-widget { display: none !important; }",
    });
  }

  const frames: { image: PNG; delay: number }[] = [];
  const capture = async (delay = 120) => {
    const [left, right] = await Promise.all([ada.screenshot(), grace.screenshot()]);
    frames.push({ image: sideBySide(PNG.sync.read(left), PNG.sync.read(right)), delay });
  };
  const type = async (page: Page, text: string) => {
    for (let i = 0; i < text.length; i += 4) {
      await page.keyboard.type(text.slice(i, i + 4));
      await capture();
    }
    await page.keyboard.press("Escape");
  };

  // Start one blank line down so the name label on line 1 isn't clipped.
  await ada.locator(".monaco-editor .view-lines").click();
  await ada.keyboard.press("Enter");
  await capture(600);
  await type(ada, "names = ['Ada', 'Grace']");
  await ada.keyboard.press("End");
  await ada.keyboard.press("Enter");
  await grace.locator(".monaco-editor .view-lines").click();
  await grace.keyboard.press("Control+End");
  await capture(400);
  await type(grace, "print(' + '.join(names))");
  await capture(500);

  // Both at once.
  await ada.keyboard.press("Control+Home");
  await grace.keyboard.press("Control+End");
  await grace.keyboard.press("Enter");
  const comment = "# written together";
  const line = "print(len(names))";
  for (let i = 0; i < Math.max(comment.length, line.length); i += 3) {
    await Promise.all([
      ada.keyboard.type(comment.slice(i, i + 3)),
      grace.keyboard.type(line.slice(i, i + 3)),
    ]);
    await capture();
  }
  await capture(700);

  await ada.getByRole("button", { name: "Run ▶" }).click();
  await ada.getByTestId("run-meta").waitFor({ timeout: 30_000 });
  await expect(ada.getByTestId("run-stdout")).toHaveText("Ada + Grace\n2\n");
  await capture(1200);

  await grace.getByLabel("Chat message").fill("It runs!");
  await capture(300);
  await grace.getByRole("button", { name: "Send" }).click();
  await expect(ada.getByTestId("chat-message")).toContainText("It runs!");
  await capture(2500);

  const first = frames[0]?.image;
  const last = frames.at(-1)?.image;
  if (!first || !last) throw new Error("no frames captured");
  const palette = quantize(new Uint8Array(Buffer.concat([first.data, last.data])), 128);
  const gif = GIFEncoder();
  for (const { image, delay } of frames) {
    const index = applyPalette(new Uint8Array(image.data), palette);
    gif.writeFrame(index, image.width, image.height, { palette, delay });
  }
  gif.finish();
  writeFileSync(new URL("../../docs/demo.gif", import.meta.url), gif.bytes());
  console.log(`${frames.length} frames, ${Math.round(gif.bytes().length / 1024)} KB`);
  await ada.screenshot({ path: test.info().outputPath("ada.png") });
  await grace.screenshot({ path: test.info().outputPath("grace.png") });
});

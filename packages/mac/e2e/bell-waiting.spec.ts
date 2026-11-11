import { expect, test, type Page } from "./fixtures.js";
import { openWork } from "./helpers.js";

/**
 * Opening the bell with something waiting (BLG-905). It froze the window grey: a request's
 * answers (a plan's Verify, Then Approve) sat deeper than the list's compare could see, so the
 * list never read the same and React redrew the bell until it gave up and unmounted the window.
 * Now it opens, lists the request, and the window keeps working. The friend's-agent case runs in
 * the demo's people scene (BELUGA_DEMO_SCENE=people: mia's agent asks for the deploy key).
 */

const sidebar = (page: Page) =>
  page.getByRole("navigation", { name: "Sidebar" });

// The plan's Verify, Then Approve carries { thenApprove: true }, as deep as the old compare stopped.
// A redraw that never ends fails any test (fixtures.ts), so this fails on the old bell.
test("the bell opens with a plan waiting for approval", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await openWork(page, "Plans");
  if (
    !(await page.getByRole("button", { name: "Project: bob-api" }).isVisible())
  ) {
    await page.getByRole("button", { name: /^Project: / }).click();
    await page.getByRole("menuitem", { name: /bob-api/ }).click();
  }
  await page.getByRole("button", { name: "New Plan", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: /^Plan in / });
  await sheet
    .getByLabel("Goal")
    .fill("Tidy the webhook handlers and add tests for retries.");
  await sheet.getByRole("button", { name: "Plan with Your Agent" }).click();
  await expect(page.getByRole("button", { name: "Approve Plan" })).toBeVisible({
    timeout: 60_000,
  });

  const bell = page.getByRole("button", { name: /^Notifications/ }).first();
  await bell.click();
  const centre = page.getByRole("dialog", { name: "Notifications" });
  const waiting = centre.getByRole("region", { name: "Waiting for you" });
  await expect(waiting.getByText(/^Approve the plan/)).toBeVisible();
  await expect(
    centre.getByText("Notifications ran into a problem"),
  ).toHaveCount(0);
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await expect(centre).toHaveCount(0);
  await expect(sidebar(page)).toBeVisible();
});

test.describe("with a friend’s agent asking", () => {
  test.skip(
    process.env.BELUGA_DEMO_SCENE !== "people",
    "needs BELUGA_DEMO_SCENE=people",
  );

  test("the bell opens with a friend’s agent request waiting, and the window keeps working", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto("/");
    await expect(sidebar(page)).toBeVisible();
    const card = sidebar(page).getByRole("group", {
      name: "Talk with friends",
    });
    if (await card.isVisible())
      await card.getByRole("button", { name: "Turn On" }).click();
    const bell = page.getByRole("button", { name: /^Notifications/ }).first();
    await expect(bell).toHaveAccessibleName(/waiting for you/, {
      timeout: 60_000,
    });

    await bell.click();
    const centre = page.getByRole("dialog", { name: "Notifications" });
    const waiting = centre.getByRole("region", { name: "Waiting for you" });
    await expect(waiting.getByText(/mia.s agent wants/)).toBeVisible();
    await expect(
      waiting.getByRole("button", { name: "Allow once" }),
    ).toBeVisible();
    await expect(
      centre.getByText("Notifications ran into a problem"),
    ).toHaveCount(0);
    if (process.env.SHOTS)
      await page.screenshot({
        path: `${process.env.SHOTS}/bell-friend-request.png`,
      });

    // Still drawing and answering: filters switch, the bell closes, the sidebar works.
    await centre.getByRole("tab", { name: "Needs you" }).click();
    await centre.getByRole("tab", { name: "All" }).click();
    await page.keyboard.press("Escape");
    await expect(centre).toHaveCount(0);
    await sidebar(page).getByRole("button", { name: "Overview" }).click();
    await expect(
      page
        .getByRole("heading", { name: "Overview" })
        .or(page.getByText("Overview").first()),
    ).toBeVisible();
    expect(
      errors.filter((e) =>
        /Maximum update depth|getSnapshot|Minified React error #185/.test(e),
      ),
    ).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launch } from "./browser.ts";

it("follows the synthetic cookie, checkbox and lure gates without transmitting entered values", async () => {
  const pages = Object.fromEntries(
    ["index", "lure", "login", "submitted"].map((name) => [
      name,
      readFileSync(join(import.meta.dirname, `../../fixtures/nimbusmail-multistep/${name}.html`), "utf8"),
    ]),
  );
  const browser = await launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    page.setDefaultNavigationTimeout(3000);
    const requests: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      requests.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`);
      const path = new URL(request.url()).pathname;
      const name = path.split("/").at(-1) || "index";
      const html = pages[name];
      if (!html) throw new Error("unexpected fixture request");
      await route.fulfill({ status: 200, contentType: "text/html", body: html });
    });
    await page.goto("https://fixtures.example/prefix/nimbusmail-multistep/");
    expect(await page.getByLabel("I am human").isVisible()).toBe(false);
    await page.getByRole("button", { name: "Accept cookies" }).click();
    await page.getByLabel("I am human").click();
    await page.waitForURL("**/lure");
    await page.getByRole("link", { name: "View document" }).click();
    await page.waitForURL("**/login");
    await page.getByLabel("Email address").fill("canary-0123456789ab@canary.isitlegit.co.za");
    await page.getByLabel("Password").fill("IsItLegit-Canary-0123456789ABCDEFGHJK");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/submitted");
    expect(await page.getByText("Test finished. No credentials were sent.").isVisible()).toBe(true);
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    expect(requests.join("\n")).not.toContain("canary-");
    expect(requests.join("\n")).not.toContain("IsItLegit-Canary-0123456789ABCDEFGHJK");
    for (const html of Object.values(pages)) {
      expect(html).toContain('name="robots" content="noindex,nofollow"');
      expect(html).toContain("Synthetic test fixture");
    }
  } finally {
    await browser.close();
  }
});

import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "./browser";
import { passkeyHarness } from "./passkey-stub.tsx";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

// D07 T02 §16: the passkey sign-in page's own behaviour around the ceremony: every recovery, the one-at-a-time rule
// and the stall bound, by keyboard, with the Worker's answers stubbed (test/node/passkey-stub.tsx). The ceremony against
// the real verifier is test/node/passkey-e2e-browser.test.tsx, the accessibility matrix passkey-a11y-browser.test.tsx.
describe("the passkey prompt and its recoveries", () => {
  const h = passkeyHarness(() => browser);
  const { stub, signinWith, message, focusedType, press } = h;
  it("offers no passkey where the browser has no WebAuthn", async () => {
    const { p, context } = await signinWith("/signin", { noWebAuthn: true });
    expect(await p.evaluate(() => typeof window.PublicKeyCredential)).toBe("undefined");
    expect(await p.locator("[data-passkey]").isHidden()).toBe(true);
    expect(await p.getByRole("button", { name: "Email me a sign-in link" }).isVisible()).toBe(true);
    await context.close();
  });

  it("keeps the address typed, and says the service's failure, when the options cannot be had", async () => {
    const { p, context } = await signinWith("/signin");
    await p.getByLabel("Work email").fill("lindiwe@karoocouriers.example");
    stub.optionsStatus = 500;
    await press(p);
    await expect.poll(() => message(p)).toContain("Passkey sign-in did not finish");
    expect(await p.getByLabel("Work email").inputValue()).toBe("lindiwe@karoocouriers.example");
    expect(await focusedType(p)).toBe("email");
    expect(stub.verify).toBe(0);
    // Try again from the page, by keyboard, once the service answers.
    stub.optionsStatus = 200;
    await press(p);
    await p.waitForURL(`${h.site}/cases/42`);
    await context.close();
  });

  it("offers no passkey without the script, and the email route still works", async () => {
    const { p, context } = await signinWith("/signin", { script: false });
    expect(await p.getByRole("button", { name: "Sign in with a passkey" }).isVisible()).toBe(false);
    expect(await p.locator("[data-passkey]").isHidden()).toBe(true);
    await p.getByLabel("Work email").fill("m@k.example");
    await p.getByRole("button", { name: "Email me a sign-in link" }).click();
    await p.waitForURL(`${h.site}/signin/link`);
    expect(stub.links).toBe(1);
    await context.close();
  });

  it("names the phone, its QR scan and Bluetooth in the prompt's panel", async () => {
    const { p, context } = await signinWith("/signin");
    stub.optionsDelayMs = 600;
    await press(p);
    await expect
      .poll(async () => (await p.textContent("main"))?.replace(/\s+/g, " "))
      .toContain(
        "choose the QR code option in the window your browser opened, scan it with your phone (Bluetooth on both), then approve and unlock on your phone",
      );
    expect(await p.getByRole("button", { name: "Email me a link instead" }).isVisible()).toBe(true);
    stub.optionsDelayMs = 0;
    await context.close();
  });

  it("names each stuck cause with its fix in the panel, and keeps them after a cancelled ceremony (D07 T02 s28)", async () => {
    const causes = [
      "Your phone has no screen lock: set up a PIN, fingerprint or face lock, then try again.",
      "Your browser is older and cannot use a phone passkey: update it, or sign in with an email link.",
      "Bluetooth is off: turn it on on this device and on your phone, then try again.",
    ];
    const { p, context } = await signinWith("/signin", { width: 360 });
    stub.optionsDelayMs = 600;
    await press(p);
    for (const theme of ["light", "dark"] as const) {
      await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      const text = (await p.textContent("[data-passkey-prompt]"))?.replace(/\s+/g, " ") ?? "";
      for (const cause of causes) expect(text, theme).toContain(cause);
      expect(await p.evaluate(() => document.documentElement.scrollWidth), theme).toBeLessThanOrEqual(360);
    }
    stub.optionsDelayMs = 0;
    await context.close();
    // Cancelled (no passkey answers): the note stays on the sign-in page, and the email recovery works by keyboard.
    const cancelled = await signinWith("/signin", { none: true, width: 360 });
    await press(cancelled.p);
    await expect.poll(() => message(cancelled.p)).toContain("No passkey was used");
    expect(await cancelled.p.locator("[data-passkey-help]").isVisible()).toBe(true);
    const help = (await cancelled.p.textContent("[data-passkey-help]"))?.replace(/\s+/g, " ") ?? "";
    for (const cause of causes) expect(help).toContain(cause);
    await cancelled.p.getByLabel("Work email").fill("m@k.example");
    await cancelled.p.getByRole("button", { name: "Email me a sign-in link" }).focus();
    await cancelled.p.keyboard.press("Enter");
    await cancelled.p.waitForURL(`${h.site}/signin/link`);
    expect(stub.links).toBe(1);
    await cancelled.context.close();
  });

  it("shows the prompt with focus on its heading and the button busy, then lands on the return path", async () => {
    const { p, context } = await signinWith("/signin");
    stub.optionsDelayMs = 600;
    await press(p);
    await expect.poll(() => p.evaluate(() => document.activeElement?.textContent)).toBe("Confirm it is you");
    expect(await p.getByRole("button", { name: "Try the passkey again" }).getAttribute("aria-busy")).toBe("true");
    expect(await p.getByLabel("Work email").isVisible()).toBe(false);
    await p.waitForURL(`${h.site}/cases/42`);
    expect([stub.options, stub.verify]).toEqual([1, 1]);
    await context.close();
  });

  for (const [code, words] of [
    ["USER_VERIFICATION_REQUIRED", "Your device was not unlocked"],
    ["PASSKEY_NOT_FOUND", "This passkey is no longer on your account; sign in with an email link."],
    ["AUTHENTICATION_FAILED", "That passkey could not be checked"],
    ["SOMETHING_ELSE", "Passkey sign-in did not finish"],
  ] as const)
    it(`ends a ${code} refusal on the email field, the reason announced`, async () => {
      const { p, context } = await signinWith("/signin");
      stub.answers = [{ status: code === "SOMETHING_ELSE" ? 500 : 401, code }];
      await press(p);
      await expect.poll(() => message(p)).toContain(words);
      expect(await p.locator("[data-passkey-message]").getAttribute("role")).toBe("alert");
      expect(await focusedType(p)).toBe("email");
      expect(await p.locator("[data-passkey-prompt]").isHidden()).toBe(true);
      expect(await p.getByRole("button", { name: "Sign in with a passkey" }).getAttribute("aria-busy")).toBeNull();
      expect(new URL(p.url()).pathname).toBe("/signin");
      await context.close();
    });

  it("says so when this device has no passkey, at once", async () => {
    const { p, context } = await signinWith("/signin", { none: true });
    const started = Date.now();
    await press(p);
    await expect.poll(() => message(p), { timeout: 10_000 }).toContain("No passkey was used");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await focusedType(p)).toBe("email");
    expect(stub.verify).toBe(0);
    await context.close();
  });

  it("asks for new options once when the challenge has run out, then stops", async () => {
    const renewed = await signinWith("/signin");
    stub.answers = [{ status: 400, code: "CHALLENGE_NOT_FOUND" }];
    await press(renewed.p);
    await renewed.p.waitForURL(`${h.site}/cases/42`);
    expect([stub.options, stub.verify]).toEqual([2, 2]);
    await renewed.context.close();
    const twice = await signinWith("/signin");
    stub.answers = [
      { status: 400, code: "CHALLENGE_NOT_FOUND" },
      { status: 400, code: "CHALLENGE_NOT_FOUND" },
    ];
    await press(twice.p);
    await expect.poll(() => message(twice.p)).toContain("Passkey sign-in did not finish");
    expect([stub.options, stub.verify]).toEqual([2, 2]);
    await twice.context.close();
  });

  it("runs one ceremony at a time: a second press replaces the first, and only the live one signs in", async () => {
    const { p, context } = await signinWith("/signin");
    stub.optionsDelayMs = 800;
    await press(p);
    await p.getByRole("button", { name: "Try the passkey again" }).focus();
    await p.keyboard.press("Enter");
    await p.waitForURL(`${h.site}/cases/42`);
    expect(stub.options).toBe(2);
    expect(stub.verify).toBe(1);
    await context.close();
  });

  it("drops the ceremony for Email me a link instead, even when its answer comes after", async () => {
    const before = await signinWith("/signin");
    stub.optionsDelayMs = 800;
    await press(before.p);
    // The browser's own end of the request: the ceremony's abort fails it, so no answer can reach the page after.
    const optionsDropped = before.p.waitForEvent("requestfailed", (r) =>
      r.url().includes("generate-authenticate-options"),
    );
    await before.p.getByRole("button", { name: "Email me a link instead" }).focus();
    await before.p.keyboard.press("Enter");
    expect(await focusedType(before.p)).toBe("email");
    expect(await before.p.locator("[data-passkey-prompt]").isHidden()).toBe(true);
    await optionsDropped;
    // The late answer has gone out too (the stub sent it), and the page made nothing of it.
    await expect.poll(() => stub.answered, { timeout: 5_000 }).toBe(1);
    expect([stub.options, stub.verify]).toEqual([1, 0]);
    expect(new URL(before.p.url()).pathname).toBe("/signin");
    await before.context.close();

    const late = await signinWith("/signin");
    stub.verifyDelayMs = 1000;
    await press(late.p);
    await expect.poll(() => stub.verify).toBe(1);
    const verifyDropped = late.p.waitForEvent("requestfailed", (r) => r.url().includes("verify-authentication"));
    await late.p.getByRole("button", { name: "Email me a link instead" }).focus();
    await late.p.keyboard.press("Enter");
    // The browser failed the verification request when the ceremony was dropped, and the stub's late answer went out
    // after; the page stayed.
    await verifyDropped;
    await expect.poll(() => stub.answered, { timeout: 5_000 }).toBe(2);
    expect(new URL(late.p.url()).pathname).toBe("/signin");
    expect(await message(late.p)).toBe("");
    await late.context.close();
  });

  // The page's clock measures the 15-second bound, so the test moves it rather than waiting it out: nothing ends the
  // request before the bound, and the retry state follows right after it.
  for (const stalled of ["options", "verification"] as const)
    it(`ends a ${stalled} request that never answers in the retry state, within its bound, then signs in afresh`, async () => {
      const { p, context } = await signinWith("/signin", { clock: true });
      if (stalled === "options") stub.optionsHang = true;
      else stub.verifyHang = true;
      await press(p);
      await expect.poll(() => (stalled === "options" ? stub.options : stub.verify)).toBe(1);
      await p.clock.fastForward(14_000);
      expect(await message(p)).toBe("");
      expect(await p.locator("[data-passkey-prompt]").isVisible()).toBe(true);
      await p.clock.fastForward(1_100);
      await expect.poll(() => message(p)).toContain("took too long");
      expect(await focusedType(p)).toBe("email");
      // A fresh ceremony, once the service answers, signs in.
      stub.optionsHang = false;
      stub.verifyHang = false;
      await press(p);
      await p.waitForURL((url) => url.pathname === "/cases/42");
      await context.close();
    });

  // A page with no email field to return to: the invitation's link request takes focus, and on the rate-limited state,
  // whose request is held until the time it names, the state's heading, which says when links can be sent again. Both
  // a refusal and "Email me a link instead" end there.
  for (const [path, landed] of [
    ["/signin/limited", "Too many sign-in links from here"],
    ["/invite/demo", "Email me a sign-in link"],
  ] as const)
    it(`ends on the page's own email route where there is no email field (${path})`, async () => {
      const { p, context } = await signinWith(path);
      const focusedText = () => p.evaluate(() => document.activeElement?.textContent?.trim());
      stub.answers = [{ status: 401, code: "AUTHENTICATION_FAILED" }];
      await press(p);
      await expect.poll(() => message(p)).toContain("could not be checked");
      expect(await focusedText()).toBe(landed);
      stub.optionsDelayMs = 800;
      await press(p);
      await p.getByRole("button", { name: "Email me a link instead" }).focus();
      await p.keyboard.press("Enter");
      expect(await focusedText()).toBe(landed);
      expect(await p.locator("[data-passkey-prompt]").isHidden()).toBe(true);
      if (path === "/signin/limited")
        expect(await p.getByRole("button", { name: /^Send another link at \d\d:\d\d$/ }).isDisabled()).toBe(true);
      await context.close();
    });

  it("offers the passkey on the rate-limited state too, signing in from there", async () => {
    const { p, context } = await signinWith("/signin/limited");
    await press(p);
    await p.waitForURL(`${h.site}/cases/42`);
    await context.close();
  });
});

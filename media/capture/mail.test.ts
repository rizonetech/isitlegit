// node --test capture/: the link the rig opens from a mail is the app's own, unwrapped when Safe Links rewrote it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { appLink } from "./mail.ts";

const APP = "https://app.isitlegit.co.za";

test("takes the first link on the app's own host", () => {
  assert.equal(appLink(["https://outlook.office.com/x", `${APP}/signin/confirm?token=t1`], APP), `${APP}/signin/confirm?token=t1`);
});

test("unwraps a Safe Links rewrite", () => {
  const wrapped = `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(`${APP}/signin/confirm?token=t2`)}&data=x`;
  assert.equal(appLink([wrapped], APP), `${APP}/signin/confirm?token=t2`);
});

test("refuses a lookalike host and garbage", () => {
  assert.equal(appLink(["https://app.isitlegit.co.za.evil.example/signin", "not a url"], APP), null);
});

// The monitor's screening of captured pages (D05 T04 §3). This file grows with the section; it starts with the parking
// rules (correction 10): a sale or parking page, or an empty one, is parked and screened by no model, and anything that
// might be a form, or a page that says little in words and much in pictures, is screened.
import { describe, expect, it } from "vitest";
import { parkedPage, type Signals } from "../../src/monitor/parked";

const NONE: Signals = { inputs: 0, passwords: 0, forms: 0, iframes: 0 };
const SMALL = 6_000;
const BIG = 160_000;
const lorem = (n: number) => "Quarterly freight rates for coastal routes and inland depots. ".repeat(Math.ceil(n / 62));

describe("parked pages", () => {
  const parked: [string, string][] = [
    ["a Sedo page", "kestrelfreight.example. This domain is for sale. Sedo domain parking. Make an offer."],
    [
      "an Afternic page",
      "Buy this domain: kestrelfreight.example is available through Afternic. Get a price in minutes.",
    ],
    ["a HugeDomains page", "kestrelfreight.example is for sale at HugeDomains. Your purchase is protected."],
    ["a Dan.com page", "kestrelfreight.example. Available on dan.com. Lease to own, from a small monthly amount."],
    [
      "a registrar's parked page",
      "This web page is parked. kestrelfreight.example is registered with Example Registrar.",
    ],
    ["a ParkingCrew page", "Related searches. Sponsored listings. Powered by ParkingCrew."],
  ];
  for (const [what, text] of parked)
    it(`parks ${what}`, () => {
      expect(parkedPage(text, NONE, SMALL)).toMatchObject({ parked: true });
    });

  it("parks an empty page, naming why, and a page of only a few characters", () => {
    expect(parkedPage("", NONE, 2_000)).toEqual({ parked: true, reason: "empty" });
    expect(parkedPage("  Welcome  ", NONE, 3_000)).toEqual({ parked: true, reason: "empty" });
  });

  it("names the marker that parked a page", () => {
    expect(parkedPage("This domain is for sale. Sedo.", NONE, SMALL)).toEqual({ parked: true, reason: "sedo" });
  });
});

describe("pages that are screened, never parked", () => {
  const sale = "kestrelfreight.example. This domain is for sale. Sedo domain parking.";
  const cases: [string, ReturnType<typeof parkedPage>][] = [
    [
      "a sale page with a password field that has only a placeholder",
      parkedPage(sale, { ...NONE, inputs: 1, passwords: 1 }, SMALL),
    ],
    ["a sale page with a form whose labels are an image", parkedPage(sale, { ...NONE, forms: 1, inputs: 2 }, SMALL)],
    ["a sale page with an iframe", parkedPage(sale, { ...NONE, iframes: 1 }, SMALL)],
    ["a sale page that also names a login", parkedPage(`${sale} Sign in to your account.`, NONE, SMALL)],
    ["a sale page that asks for a card", parkedPage(`${sale} Enter your card number to continue.`, NONE, SMALL)],
    ["a long page that mentions a sale", parkedPage(`${lorem(2_500)} The domain is for sale.`, NONE, SMALL)],
    ["an image-led page: little text, a large screenshot", parkedPage(sale, NONE, BIG)],
    ["an empty page with a large screenshot", parkedPage("", NONE, BIG)],
    ["a capture with no signals, as one made before they were taken", parkedPage(sale, null, SMALL)],
    ["a sale page with an input of any kind", parkedPage(sale, { ...NONE, inputs: 1 }, SMALL)],
  ];
  for (const [what, result] of cases)
    it(`screens ${what}`, () => {
      expect(result).toEqual({ parked: false });
    });

  it("does not park a page for a word that only sounds like a form word", () => {
    expect(parkedPage("A pin-striped suit for sale at Kestrel Tailors. Opening hours and a map.", NONE, SMALL)).toEqual(
      {
        parked: false,
      },
    );
  });
});

// The monitor's synthetic candidate pages (D03 T04 §1): 40 pages of fictional brands, 20 lures and 20 benign, written
// here, never drawn from the training data store, for measuring Loupe and Muse Spark on pages like the monitor's.
//
//   node scripts/glimmer/monitor-pages.ts build    # write the pages, render them, write labels.json and MANIFEST.json
//   node scripts/glimmer/monitor-pages.ts check    # hash Loupe 1.0's training screenshots and write OVERLAP.json
//   node scripts/glimmer/monitor-pages.ts dataset  # the set as evaluate.ts reads a dataset, in the store
//   node scripts/glimmer/monitor-pages.ts loupe    # a warm-up from 0 replicas, the 40 pages on the warm deployment
//   node scripts/glimmer/monitor-pages.ts spark    # the 40 pages on Muse Spark, under the lane's Spark cap
//   node scripts/glimmer/monitor-pages.ts score    # both screeners' figures, written to runs/metrics.json
//
// The screeners answer through evaluate.ts's runs (answers bound to the set's file and the model, a page answered
// once, scored only when complete), into `eval/sets/monitor-pages/runs/`. Loupe is asked on the dedicated deployment
// with the screener's own body (`glimmerBody`: the JSON schema format), inside a warm-up whose wake reserves the run's
// minutes in the runtime ledger (§14), so its cold start is measured too (§13).
//
// Each page is rendered inertly (no scripts, every request refused) at the training captures' 1280 by 2000 and stored
// as a JPEG (quality 85, as the dataset stores them), with its visible text. Every file is written temp then rename.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import sharp from "sharp";
import type { MetaContext } from "../../src/meta/client.ts";
import { structured } from "../../src/meta/structured.ts";
import { DEPLOYED_MODEL, DEPLOYED_VERSION, DEPLOYMENT, hourlyRateUsd } from "../../src/vision/glimmer-caps.ts";
import { buildScreenRequest, PageAnswer } from "../../src/vision/page-screen.ts";
import { glimmerBody, sparkRequest } from "../../src/vision/screen-request.ts";
import { configureNetwork } from "../fireworks-check.ts";
import { chromiumPath } from "../lib/chromium.ts";
import { localBudget } from "../lib/meta-budget.ts";
import { GATEWAY_URL, metaLedger, readSecretsFromVault } from "../meta-smoke.ts";
import { measureWarmup, openDeployments, readKey } from "./deploy.ts";
import { askLoupe, readAnswers, readInferenceKey, runAnswers, scoreSet, sparkEvaluation } from "./evaluate.ts";
import { type Ask, ledgerBudget, sharedClock } from "./teacher-label.ts";

// Spark as the screener's fallback asks it (`sparkRequest` through `structured()`, the answer validated as a
// PageAnswer), every attempt reserved in the lane's ledger under its cap as the teacher's were (`ledgerBudget`).
export function screenerSpark(context: Omit<MetaContext, "owner">): Ask {
  return async (input, instructions, attempts) => {
    const { budget, spent } = ledgerBudget(context.budget, attempts);
    const answer = await structured(
      PageAnswer,
      { ...sparkRequest({ messages: [] }), input: input as never, instructions },
      { ...context, budget, owner: { kind: "script", name: "glimmer-monitor-pages" }, waitUntil: () => {} },
    );
    return { text: JSON.stringify(answer.value), usd: spent() };
  };
}

const ROOT = resolve(import.meta.dirname, "../..");
export const SET_DIR = join(ROOT, "eval", "sets", "monitor-pages");
const WIDTH = 1280;
const HEIGHT = 2000;

export type LureType = "credential" | "payment" | "fake_shop" | "impersonation" | "none";
export type PageSpec = { id: string; host: string; brand: string; lure: boolean; lure_type: LureType; html: string };

// The fictional brands, each with its own domain and colour.
const BRANDS = {
  fynbos: { name: "Fynbos Freight", domain: "fynbosfreight.example", colour: "#1f6f4a" },
  karoo: { name: "Karoo Mutual Bank", domain: "karoomutual.example", colour: "#7a2e1f" },
  protea: { name: "Protea Mobile", domain: "proteamobile.example", colour: "#c2185b" },
  baobab: { name: "Baobab Pay", domain: "baobabpay.example", colour: "#3b4a9c" },
  umhlanga: { name: "Umhlanga Energy", domain: "umhlangaenergy.example", colour: "#e07a00" },
  kloof: { name: "Kloof Insurance", domain: "kloofinsure.example", colour: "#2b6b8f" },
  springbok: { name: "Springbok Parcels", domain: "springbokparcels.example", colour: "#8a6d1d" },
  tablebay: { name: "Table Bay Telecom", domain: "tablebaytel.example", colour: "#00796b" },
  highveld: { name: "Highveld Health", domain: "highveldhealth.example", colour: "#5e35b1" },
  marula: { name: "Marula Rewards", domain: "marularewards.example", colour: "#ad1457" },
} as const;
type Brand = { name: string; domain: string; colour: string };

const page = (title: string, colour: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>
body{font-family:Arial,Helvetica,sans-serif;margin:0;background:#f5f5f5;color:#222}
header{background:${colour};color:#fff;padding:18px 40px;font-size:26px;font-weight:bold}
main{max-width:760px;margin:40px auto;background:#fff;padding:32px 40px;border-radius:6px}
label{display:block;margin:14px 0 4px}input{width:100%;padding:10px;font-size:16px;border:1px solid #bbb;border-radius:4px}
button{margin-top:20px;background:${colour};color:#fff;border:0;padding:12px 28px;font-size:17px;border-radius:4px}
.note{color:#666;font-size:14px;margin-top:18px}.warn{background:#fdecea;color:#8a1c12;padding:12px;border-radius:4px}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}.item{border:1px solid #ddd;padding:12px;border-radius:4px}
.price{font-size:20px;font-weight:bold}.old{text-decoration:line-through;color:#999}footer{text-align:center;color:#888;font-size:13px;padding:24px}
</style></head><body>${body}<footer>&copy; 2026</footer></body></html>`;

const login = (b: Brand, intro: string, extra = "") =>
  page(
    `${b.name}: sign in`,
    b.colour,
    `<header>${b.name}</header><main><h1>Sign in</h1>${intro}<form><label>Email or username</label><input type="text"><label>Password</label><input type="password">${extra}<button>Sign in</button></form><p class="note">Forgot your password? Reset it from the sign-in page.</p></main>`,
  );
const card = (b: Brand, intro: string) =>
  page(
    `${b.name}: payment`,
    b.colour,
    `<header>${b.name}</header><main>${intro}<form><label>Name on card</label><input><label>Card number</label><input inputmode="numeric"><label>Expiry (MM/YY)</label><input><label>CVV</label><input inputmode="numeric"><button>Pay now</button></form></main>`,
  );
const shop = (b: Brand, title: string, items: [string, string, string][], banner: string) =>
  page(
    title,
    b.colour,
    `<header>${b.name} store</header><main>${banner}<div class="grid">${items
      .map(
        ([name, price, old]) =>
          `<div class="item"><b>${name}</b><p class="price">${price}</p>${old ? `<p class="old">${old}</p>` : ""}<button>Add to cart</button></div>`,
      )
      .join("")}</div></main>`,
  );
const article = (b: Brand, title: string, paragraphs: string[]) =>
  page(
    title,
    b.colour,
    `<header>${b.name}</header><main><h1>${title}</h1>${paragraphs.map((p) => `<p>${p}</p>`).join("")}</main>`,
  );

const F = BRANDS;
// 20 lures: 8 credential, 5 payment, 4 fake shops, 3 impersonation. 20 benign: the brands' own pages and others.
export const PAGES: PageSpec[] = [
  {
    id: "lure-01",
    host: "fynbosfreight-tracking.example",
    brand: F.fynbos.name,
    lure: true,
    lure_type: "credential",
    html: login(F.fynbos, `<p class="warn">Your parcel is on hold. Sign in within 24 hours to release it.</p>`),
  },
  {
    id: "lure-02",
    host: "karoomutual-secure-login.example",
    brand: F.karoo.name,
    lure: true,
    lure_type: "credential",
    html: login(
      F.karoo,
      `<p class="warn">Unusual activity was detected on your account. Verify your identity to avoid suspension.</p>`,
      `<label>One-time PIN</label><input>`,
    ),
  },
  {
    id: "lure-03",
    host: "proteamobile-account.example",
    brand: F.protea.name,
    lure: true,
    lure_type: "credential",
    html: login(F.protea, `<p>Your free data bundle is waiting. Sign in to claim it before midnight.</p>`),
  },
  {
    id: "lure-04",
    host: "baobabpay-verify.example",
    brand: F.baobab.name,
    lure: true,
    lure_type: "credential",
    html: login(
      F.baobab,
      `<p class="warn">Your wallet has been limited. Confirm your login details to restore it.</p>`,
    ),
  },
  {
    id: "lure-05",
    host: "kloofinsure-claims-portal.example",
    brand: F.kloof.name,
    lure: true,
    lure_type: "credential",
    html: login(F.kloof, `<p>A claim payment of R 4,250.00 is pending. Sign in to accept it.</p>`),
  },
  {
    id: "lure-06",
    host: "tablebaytel-mail.example",
    brand: F.tablebay.name,
    lure: true,
    lure_type: "credential",
    html: login(
      F.tablebay,
      `<p class="warn">Your mailbox is full. Sign in to upgrade your storage now or lose incoming mail.</p>`,
    ),
  },
  {
    id: "lure-07",
    host: "highveldhealth-member.example",
    brand: F.highveld.name,
    lure: true,
    lure_type: "credential",
    html: login(
      F.highveld,
      `<p>Your medical aid statement is ready. Sign in with your member number and password.</p>`,
    ),
  },
  {
    id: "lure-08",
    host: "marula-rewards-points.example",
    brand: F.marula.name,
    lure: true,
    lure_type: "credential",
    html: login(F.marula, `<p class="warn">Your 18,400 points expire today. Sign in to keep them.</p>`),
  },
  {
    id: "lure-09",
    host: "fynbosfreight-customs-fee.example",
    brand: F.fynbos.name,
    lure: true,
    lure_type: "payment",
    html: card(
      F.fynbos,
      `<h1>Customs fee due</h1><p class="warn">Your parcel FF-20931 is held at customs. Pay the R 38.50 release fee to schedule delivery.</p>`,
    ),
  },
  {
    id: "lure-10",
    host: "umhlangaenergy-billing.example",
    brand: F.umhlanga.name,
    lure: true,
    lure_type: "payment",
    html: card(
      F.umhlanga,
      `<h1>Final notice</h1><p class="warn">Your electricity will be disconnected today. Settle R 1,182.40 now to avoid a reconnection fee.</p>`,
    ),
  },
  {
    id: "lure-11",
    host: "springbokparcels-redelivery.example",
    brand: F.springbok.name,
    lure: true,
    lure_type: "payment",
    html: card(F.springbok, `<h1>Redelivery</h1><p>We missed you. Pay R 24.99 to book a new delivery slot.</p>`),
  },
  {
    id: "lure-12",
    host: "proteamobile-billing-update.example",
    brand: F.protea.name,
    lure: true,
    lure_type: "payment",
    html: card(
      F.protea,
      `<h1>Payment failed</h1><p class="warn">Your last debit order failed. Update your card to keep your number active.</p>`,
    ),
  },
  {
    id: "lure-13",
    host: "karoomutual-refund.example",
    brand: F.karoo.name,
    lure: true,
    lure_type: "payment",
    html: card(
      F.karoo,
      `<h1>Tax refund</h1><p>You are owed a refund of R 3,960.00. Enter your card to receive it within 2 hours.</p>`,
    ),
  },
  {
    id: "lure-14",
    host: "marula-outlet-sale.example",
    brand: F.marula.name,
    lure: true,
    lure_type: "fake_shop",
    html: shop(
      F.marula,
      "Marula outlet: 90% off",
      [
        ["Smart TV 55 inch", "R 799", "R 9,999"],
        ["Air fryer", "R 149", "R 1,899"],
        ["Running shoes", "R 99", "R 1,499"],
      ],
      `<p class="warn">Closing down sale! Today only. Pay by EFT for an extra 10% off.</p>`,
    ),
  },
  {
    id: "lure-15",
    host: "springbok-bargains-za.example",
    brand: "Springbok Bargains",
    lure: true,
    lure_type: "fake_shop",
    html: shop(
      F.springbok,
      "Springbok Bargains",
      [
        ["Gaming console", "R 1,250", "R 12,500"],
        ["Laptop 16GB", "R 1,999", "R 18,999"],
        ["Phone 256GB", "R 999", "R 21,000"],
      ],
      `<p>Every order ships free. Only 3 left in stock!</p>`,
    ),
  },
  {
    id: "lure-16",
    host: "highveld-pharmacy-deals.example",
    brand: "Highveld Pharmacy Deals",
    lure: true,
    lure_type: "fake_shop",
    html: shop(
      F.highveld,
      "Highveld Pharmacy Deals",
      [
        ["Weight loss pills (90)", "R 59", "R 899"],
        ["Vitamin pack", "R 29", "R 499"],
        ["Glucose meter", "R 49", "R 1,200"],
      ],
      `<p class="warn">No prescription needed. Payment by crypto or instant EFT only.</p>`,
    ),
  },
  {
    id: "lure-17",
    host: "tablebay-phones-clearance.example",
    brand: "Table Bay Phones",
    lure: true,
    lure_type: "fake_shop",
    html: shop(
      F.tablebay,
      "Table Bay clearance",
      [
        ["Flagship phone", "R 1,499", "R 24,999"],
        ["Tablet 11 inch", "R 699", "R 8,999"],
        ["Earbuds", "R 79", "R 2,499"],
      ],
      `<p>Warehouse clearance: 95% off while stocks last.</p>`,
    ),
  },
  {
    id: "lure-18",
    host: "fynbosfreight-support-desk.example",
    brand: F.fynbos.name,
    lure: true,
    lure_type: "impersonation",
    html: article(F.fynbos, "Fynbos Freight official support", [
      "Having trouble with a delivery? Our official support agents are available 24/7 on WhatsApp at 071 555 0193.",
      "Send us your tracking number, ID number and banking PIN so an agent can verify your account and release your parcel.",
      "This is the only official Fynbos Freight support channel.",
    ]),
  },
  {
    id: "lure-19",
    host: "karoomutual-giveaway.example",
    brand: F.karoo.name,
    lure: true,
    lure_type: "impersonation",
    html: article(F.karoo, "Karoo Mutual 50th anniversary giveaway", [
      "To celebrate 50 years, Karoo Mutual Bank is giving R 5,000 to the first 1,000 customers.",
      "Message our giveaway desk on WhatsApp at 082 555 0147 with your full name, account number and the OTP we send you.",
      "Hurry, the offer ends tonight.",
    ]),
  },
  {
    id: "lure-20",
    host: "umhlanga-energy-rebate.example",
    brand: F.umhlanga.name,
    lure: true,
    lure_type: "impersonation",
    html: article(F.umhlanga, "Umhlanga Energy solar rebate", [
      "Households qualify for a once-off R 2,500 solar rebate from Umhlanga Energy.",
      "Call our rebate office on 087 555 0122 and have your bank card ready so we can deposit the rebate.",
      "Rebates are paid on a first-come basis.",
    ]),
  },
  {
    id: "benign-01",
    host: F.fynbos.domain,
    brand: F.fynbos.name,
    lure: false,
    lure_type: "none",
    html: article(F.fynbos, "Track your parcel", [
      "Enter your tracking number on the home page to see where your parcel is.",
      "Fynbos Freight never asks for card details, PINs or passwords by SMS, email or WhatsApp.",
      "Our depots in Cape Town, Durban and Johannesburg are open Monday to Friday, 08:00 to 17:00.",
    ]),
  },
  {
    id: "benign-02",
    host: F.karoo.domain,
    brand: F.karoo.name,
    lure: false,
    lure_type: "none",
    html: article(F.karoo, "Interest rates from 1 November 2026", [
      "Our prime lending rate stays at 11.25%.",
      "Savings accounts earn between 6.5% and 8.1% depending on the notice period.",
      "Speak to a consultant at any branch about which account suits you.",
    ]),
  },
  {
    id: "benign-03",
    host: F.protea.domain,
    brand: F.protea.name,
    lure: false,
    lure_type: "none",
    html: article(F.protea, "Coverage map update", [
      "We added 120 new towers in the Eastern Cape this quarter.",
      "5G is now available in Gqeberha, East London and Mthatha.",
      "Check the coverage map for your area before you upgrade.",
    ]),
  },
  {
    id: "benign-04",
    host: F.baobab.domain,
    brand: F.baobab.name,
    lure: false,
    lure_type: "none",
    html: article(F.baobab, "How Baobab Pay keeps your money safe", [
      "We will never ask for your PIN or one-time password.",
      "Report a suspicious message by forwarding it to our fraud team from the app.",
      "Payments above R 5,000 need your approval in the app.",
    ]),
  },
  {
    id: "benign-05",
    host: F.umhlanga.domain,
    brand: F.umhlanga.name,
    lure: false,
    lure_type: "none",
    html: article(F.umhlanga, "Planned maintenance in Umhlanga Rocks", [
      "Power will be off on Saturday 7 November from 09:00 to 13:00 in Umhlanga Rocks.",
      "The work upgrades the substation on Lighthouse Road.",
      "No action is needed from customers.",
    ]),
  },
  {
    id: "benign-06",
    host: F.kloof.domain,
    brand: F.kloof.name,
    lure: false,
    lure_type: "none",
    html: article(F.kloof, "Making a claim", [
      "Claims can be made through your broker or at any Kloof Insurance office.",
      "Keep photos of any damage and your police case number for theft claims.",
      "Most claims are assessed within five working days.",
    ]),
  },
  {
    id: "benign-07",
    host: F.springbok.domain,
    brand: F.springbok.name,
    lure: false,
    lure_type: "none",
    html: shop(
      F.springbok,
      "Springbok Parcels shop",
      [
        ["Courier bag (5)", "R 45", ""],
        ["Packing box medium", "R 22", ""],
        ["Bubble wrap 10m", "R 59", ""],
      ],
      `<p>Packing supplies, collected at any branch.</p>`,
    ),
  },
  {
    id: "benign-08",
    host: F.tablebay.domain,
    brand: F.tablebay.name,
    lure: false,
    lure_type: "none",
    html: shop(
      F.tablebay,
      "Table Bay Telecom devices",
      [
        ["Router 5G", "R 2,499", ""],
        ["Phone basic", "R 1,299", ""],
        ["SIM starter pack", "R 1", ""],
      ],
      `<p>Prices include VAT. Contract options available in store.</p>`,
    ),
  },
  {
    id: "benign-09",
    host: F.highveld.domain,
    brand: F.highveld.name,
    lure: false,
    lure_type: "none",
    html: article(F.highveld, "Flu season advice", [
      "Flu vaccines are available at our clinics from March.",
      "Wash your hands often and stay home when you are ill.",
      "See a doctor if a fever lasts more than three days.",
    ]),
  },
  {
    id: "benign-10",
    host: F.marula.domain,
    brand: F.marula.name,
    lure: false,
    lure_type: "none",
    html: article(F.marula, "How points work", [
      "Earn one point for every R 10 you spend at partner stores.",
      "Points last 24 months from the month you earn them.",
      "Swap points for vouchers in the app or at a till point.",
    ]),
  },
  {
    id: "benign-11",
    host: "capeherald-news.example",
    brand: "Cape Herald",
    lure: false,
    lure_type: "none",
    html: article({ name: "Cape Herald", domain: "", colour: "#333" }, "Harbour upgrade approved", [
      "The city approved a R 2.1 billion upgrade to the harbour on Thursday.",
      "Work starts in March and should take three years.",
      "Fishing operators will keep access to the eastern quay throughout.",
    ]),
  },
  {
    id: "benign-12",
    host: "karoo-kitchen-blog.example",
    brand: "Karoo Kitchen",
    lure: false,
    lure_type: "none",
    html: article({ name: "Karoo Kitchen", domain: "", colour: "#6d4c41" }, "Lamb potjie for a crowd", [
      "Brown the lamb in batches, then add onions, garlic and a little tomato paste.",
      "Layer potatoes, carrots and butternut on top and do not stir.",
      "Simmer for three hours over low coals.",
    ]),
  },
  {
    id: "benign-13",
    host: "drakensberg-hikes.example",
    brand: "Drakensberg Hikes",
    lure: false,
    lure_type: "none",
    html: article({ name: "Drakensberg Hikes", domain: "", colour: "#33691e" }, "Tugela Falls trail", [
      "The trail to the top of Tugela Falls is about 13 km return.",
      "Start early and carry at least two litres of water.",
      "The chain ladders can be busy on weekends.",
    ]),
  },
  {
    id: "benign-14",
    host: "stellen-wines.example",
    brand: "Stellen Wines",
    lure: false,
    lure_type: "none",
    html: shop(
      { name: "Stellen Wines", domain: "", colour: "#6a1b4d" },
      "Stellen Wines cellar door",
      [
        ["Chenin Blanc 2024", "R 120", ""],
        ["Pinotage 2022", "R 185", ""],
        ["Cap Classique", "R 260", ""],
      ],
      `<p>Tastings daily from 10:00. Delivery in the Western Cape.</p>`,
    ),
  },
  {
    id: "benign-15",
    host: "rietvlei-municipality.example",
    brand: "Rietvlei Municipality",
    lure: false,
    lure_type: "none",
    html: article({ name: "Rietvlei Municipality", domain: "", colour: "#1a237e" }, "Water restrictions lifted", [
      "Level 2 water restrictions end on 1 December.",
      "Dams are at 87% of capacity after the winter rains.",
      "Report leaks to the municipal call centre.",
    ]),
  },
  {
    id: "benign-16",
    host: "devnotes-blog.example",
    brand: "DevNotes",
    lure: false,
    lure_type: "none",
    html: article({ name: "DevNotes", domain: "", colour: "#263238" }, "Rate limiting with a token bucket", [
      "A token bucket refills at a fixed rate and each request takes one token.",
      "When the bucket is empty, the request waits or is refused.",
      "Pick the bucket size from your burst tolerance.",
    ]),
  },
  {
    id: "benign-17",
    host: F.baobab.domain,
    brand: F.baobab.name,
    lure: false,
    lure_type: "none",
    html: login(F.baobab, `<p>Welcome back. Sign in to your Baobab Pay wallet.</p>`),
  },
  {
    id: "benign-18",
    host: F.highveld.domain,
    brand: F.highveld.name,
    lure: false,
    lure_type: "none",
    html: login(F.highveld, `<p>Members can view claims and statements after signing in.</p>`),
  },
  {
    id: "benign-19",
    host: "sunday-market-durban.example",
    brand: "Durban Sunday Market",
    lure: false,
    lure_type: "none",
    html: article({ name: "Durban Sunday Market", domain: "", colour: "#f57f17" }, "Stall holders for November", [
      "Thirty-two stalls this month, with crafts, food and plants.",
      "Parking is free in the lot behind the hall.",
      "Card machines are available at most stalls.",
    ]),
  },
  {
    id: "benign-20",
    host: "joburg-chess-club.example",
    brand: "Joburg Chess Club",
    lure: false,
    lure_type: "none",
    html: article({ name: "Joburg Chess Club", domain: "", colour: "#424242" }, "Club championship results", [
      "Thandi Mokoena won the club championship with 6.5 points from 7 games.",
      "Rapid play continues every Tuesday evening.",
      "New members are welcome; boards and clocks are provided.",
    ]),
  },
];

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function writeAtomic(path: string, data: string | Uint8Array) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// The set's own digest: every page's id, label and screenshot hash, in order.
export function setDigest(manifest: { id: string; screenshot_sha256: string; lure: boolean; lure_type: string }[]) {
  return sha256(manifest.map((m) => `${m.id}\t${m.lure}\t${m.lure_type}\t${m.screenshot_sha256}`).join("\n"));
}

async function build() {
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  for (const dir of ["pages", "screens", "texts"]) mkdirSync(join(SET_DIR, dir), { recursive: true });
  const browser = await chromium.launch({ executablePath });
  const manifest: {
    id: string;
    host: string;
    screenshot_sha256: string;
    text_sha256: string;
    lure: boolean;
    lure_type: string;
  }[] = [];
  try {
    for (const spec of PAGES) {
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        javaScriptEnabled: false,
      });
      await context.route("**/*", (route) => route.abort());
      const tab = await context.newPage();
      await tab.setContent(spec.html, { waitUntil: "load" });
      // The content's own height, as the training captures were cropped to it (the viewport is taller than these pages).
      const height = await tab.evaluate(() => Math.ceil(document.body.getBoundingClientRect().bottom));
      const png = await tab.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: WIDTH, height: Math.min(HEIGHT, height) },
      });
      const text = (await tab.innerText("body")).trim();
      await context.close();
      const jpeg = new Uint8Array(await sharp(png).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer());
      writeAtomic(join(SET_DIR, "pages", `${spec.id}.html`), spec.html);
      writeAtomic(join(SET_DIR, "screens", `${spec.id}.jpg`), jpeg);
      writeAtomic(join(SET_DIR, "texts", `${spec.id}.txt`), `${text}\n`);
      manifest.push({
        id: spec.id,
        host: spec.host,
        screenshot_sha256: sha256(jpeg),
        text_sha256: sha256(`${text}\n`),
        lure: spec.lure,
        lure_type: spec.lure_type,
      });
    }
  } finally {
    await browser.close();
  }
  const labels = Object.fromEntries(
    PAGES.map((p) => [p.id, { host: p.host, brand: p.brand, lure: p.lure, lure_type: p.lure_type }]),
  );
  writeAtomic(join(SET_DIR, "labels.json"), `${JSON.stringify(labels, null, 2)}\n`);
  writeAtomic(
    join(SET_DIR, "MANIFEST.json"),
    `${JSON.stringify({ pages: manifest.length, digest: setDigest(manifest), manifest }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ pages: manifest.length, lures: PAGES.filter((p) => p.lure).length, digest: setDigest(manifest) }),
  );
}

// Hashes every screenshot in a training file (each line's `data:image/jpeg;base64,` parts), streaming it.
export async function trainingHashes(
  file: string,
): Promise<{ file_sha256: string; lines: number; images: Set<string> }> {
  const images = new Set<string>();
  const whole = createHash("sha256");
  let lines = 0;
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of reader) {
    whole.update(`${line}\n`);
    lines += 1;
    for (const match of line.matchAll(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/g))
      images.add(sha256(Buffer.from(match[1] as string, "base64")));
  }
  return { file_sha256: whole.digest("hex"), lines, images };
}

export function overlap(setHashes: string[], images: Set<string>): string[] {
  return setHashes.filter((hash) => images.has(hash));
}

async function check(trainFile: string) {
  if (!existsSync(trainFile))
    throw new Error(`refused: the training file ${trainFile} cannot be read; the overlap is unproven`);
  const manifest = JSON.parse(readFileSync(join(SET_DIR, "MANIFEST.json"), "utf-8")) as {
    digest: string;
    manifest: { screenshot_sha256: string }[];
  };
  const hashes = manifest.manifest.map((m) => m.screenshot_sha256);
  const training = await trainingHashes(trainFile);
  const shared = overlap(hashes, training.images);
  const receipt = {
    checked_at: new Date().toISOString(),
    training_file: "dataset/1.0/train.jsonl",
    training_file_sha256: training.file_sha256,
    training_lines: training.lines,
    training_images: training.images.size,
    set_digest: manifest.digest,
    set_hashes: hashes,
    shared,
  };
  writeAtomic(join(SET_DIR, "OVERLAP.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    JSON.stringify({ training_lines: training.lines, training_images: training.images.size, shared: shared.length }),
  );
  if (shared.length) process.exit(1);
}

export const RUNS_DIR = join(SET_DIR, "runs");

export type AnswerLine = {
  id: string;
  answer: { lure: boolean } | null;
  error?: string | null;
  latency_ms: number | null;
  cost_usd: number | null;
};
// The answer files as evaluate.ts reads them: a line a kill cut short is skipped, and a page's last record stands.
export const readAnswerLines = (file: string): AnswerLine[] =>
  [...readAnswers(file).values()] as unknown as AnswerLine[];

const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
};

// The screener as production runs it (§1): Loupe's answer where it gave a valid one, Spark's after Loupe's failed
// attempt where it did not (its latency added to Loupe's), with Loupe priced by the minutes its deployment was
// charged for the run (the warm-up receipt's wake, at the deployed GPU's rate) and Spark by its settled calls. A page
// with neither answer is a failure, never a guess.
export function productionFigures(
  labels: Record<string, { lure: boolean }>,
  loupe: AnswerLine[],
  spark: AnswerLine[],
  warmup: { warmup_ms: number | null; wake_minutes: number },
  rate = hourlyRateUsd(),
) {
  // A page's last record stands, as `readAnswers` reads it: a retry that answered replaces the error before it.
  const sparkById = new Map(spark.map((line) => [line.id, line]));
  const loupeById = new Map(loupe.map((line) => [line.id, line]));
  const pages = Object.keys(labels);
  let fallbacks = 0;
  let failures = 0;
  // Unknown once any fallback page's cost is unknown: never counted as a measured zero (round 4).
  let sparkUsd: number | null = 0;
  const latencies: number[] = [];
  const answers = new Map<string, boolean>();
  for (const id of pages) {
    const own = loupeById.get(id);
    if (own?.answer && !own.error) {
      answers.set(id, own.answer.lure);
      if (own.latency_ms !== null) latencies.push(own.latency_ms);
      continue;
    }
    const other = sparkById.get(id);
    if (other?.answer && !other.error) {
      fallbacks += 1;
      answers.set(id, other.answer.lure);
      latencies.push((own?.latency_ms ?? 0) + (other.latency_ms ?? 0));
      sparkUsd = sparkUsd === null || other.cost_usd === null ? null : sparkUsd + other.cost_usd;
    } else failures += 1;
  }
  const lures = pages.filter((id) => labels[id]?.lure);
  const benign = pages.filter((id) => !labels[id]?.lure);
  const loupeUsd = (warmup.wake_minutes * rate) / 60;
  return {
    pages: pages.length,
    loupe_answered: pages.length - fallbacks - failures,
    spark_fallbacks: fallbacks,
    failures,
    lure_recall: lures.filter((id) => answers.get(id) === true).length / lures.length,
    false_alarm_rate: benign.filter((id) => answers.get(id) === true).length / benign.length,
    latency_median_ms: quantile(latencies, 0.5),
    latency_p95_ms: quantile(latencies, 0.95),
    cold_start_ms: warmup.warmup_ms,
    loupe_usd: Math.round(loupeUsd * 10_000) / 10_000,
    spark_usd: sparkUsd === null ? null : Math.round(sparkUsd * 10_000) / 10_000,
    cost_per_page_usd: sparkUsd === null ? null : Math.round(((loupeUsd + sparkUsd) / pages.length) * 10_000) / 10_000,
  };
}
export const monitorDataset = (store: string) => join(store, "monitor-pages", "dataset");

// The set as evaluate.ts reads a dataset: each page's screener request (the nonce derived from its id, so the file is
// the same every time it is written) in `eval.jsonl`, its record in `eval.meta.jsonl`, and the file's digest in
// `summary.json`.
export function writeDataset(out: string) {
  mkdirSync(out, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(SET_DIR, "MANIFEST.json"), "utf-8")) as {
    manifest: { id: string; host: string; screenshot_sha256: string; lure: boolean; lure_type: string }[];
  };
  const labels = JSON.parse(readFileSync(join(SET_DIR, "labels.json"), "utf-8")) as Record<string, { brand: string }>;
  const lines: string[] = [];
  const metas: string[] = [];
  for (const entry of manifest.manifest) {
    const request = buildScreenRequest({
      image: new Uint8Array(readFileSync(join(SET_DIR, "screens", `${entry.id}.jpg`))),
      host: entry.host,
      text: readFileSync(join(SET_DIR, "texts", `${entry.id}.txt`), "utf-8").trim(),
      mode: "image",
      nonce: sha256(`monitor-pages:${entry.id}`).slice(0, 32),
    });
    lines.push(JSON.stringify({ messages: request.messages }));
    metas.push(
      JSON.stringify({
        id: entry.id,
        source: "monitor-pages",
        origin: "synthetic",
        lure_type: entry.lure_type,
        brand: labels[entry.id]?.brand ?? null,
        south_africa: false,
        screenshot: entry.screenshot_sha256,
      }),
    );
  }
  const text = `${lines.join("\n")}\n`;
  writeAtomic(join(out, "eval.jsonl"), text);
  writeAtomic(join(out, "eval.meta.jsonl"), `${metas.join("\n")}\n`);
  writeAtomic(
    join(out, "summary.json"),
    `${JSON.stringify({ sha256: { evaluation: sha256(text) }, pages: lines.length }, null, 2)}\n`,
  );
  return { pages: lines.length, sha256: sha256(text) };
}

if (import.meta.filename === process.argv[1]) {
  const [command, ...flags] = process.argv.slice(2);
  // `--retry-errors` asks again only the pages whose answer was an error; answered pages are never asked twice.
  const retryErrors = flags.includes("--retry-errors");
  if (flags.some((flag) => flag !== "--retry-errors")) {
    console.error(`monitor-pages: unknown flag in ${flags.join(" ")}`);
    process.exit(2);
  }
  const store = process.env.GLIMMER_DATA_DIR ?? join(homedir(), "isitlegit-data", "glimmer");
  if (command === "build") await build();
  else if (command === "check") await check(join(store, "dataset", "1.0", "train.jsonl"));
  else if (command === "dataset") console.log(JSON.stringify(writeDataset(monitorDataset(store))));
  else if (command === "loupe") {
    configureNetwork();
    const dataset = monitorDataset(store);
    writeDataset(dataset);
    const key = readInferenceKey();
    const format = glimmerBody({ messages: [] }).response_format;
    let answered: unknown = null;
    const receipt = await measureWarmup(DEPLOYED_VERSION, key, openDeployments(readKey(), fetch, DEPLOYMENT), {
      // 40 pages, 4 at a time, about 4 s each: well inside 5 minutes, the time the run is given and reserved.
      whileWarmMinutes: 5,
      whileWarm: async () => {
        // The reserved window bounds every request and every wait, not only the start of each page (round 1).
        const deadlineAt = Date.now() + 5 * 60_000;
        answered = await runAnswers({
          dataset,
          runs: RUNS_DIR,
          screener: "loupe",
          ask: askLoupe(key, DEPLOYED_MODEL, {
            body: { response_format: format },
            requestMs: 10_000,
            maxWaitMs: 60_000,
            deadlineAt,
          }),
          retryErrors,
          concurrency: 4,
          model: DEPLOYED_MODEL,
          maxMs: 5 * 60_000,
        });
      },
    });
    // The warm-up the comparison ran inside: its cold start and the minutes it was charged, which price Loupe's pages.
    writeAtomic(join(RUNS_DIR, "loupe.warmup.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify({ warmup: receipt, answered }, null, 2));
  } else if (command === "spark") {
    configureNetwork();
    const dataset = monitorDataset(store);
    writeDataset(dataset);
    const secrets = await readSecretsFromVault();
    const env = { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL };
    const clock = sharedClock();
    console.log(
      JSON.stringify(
        await sparkEvaluation({
          dataset,
          runs: RUNS_DIR,
          version: DEPLOYED_VERSION,
          ledgerFile: metaLedger(),
          ask: screenerSpark({ env, budget: localBudget("glimmer-monitor-pages", undefined, clock.guard) }),
          retryErrors,
          // 40 pages at about US$0.0076 each (the held-out run's mean): US$0.50 allows it, inside the lane's cap.
          maxUsd: 0.5,
          now: clock.teacher,
          calls: "glimmer-monitor-spark-",
        }),
      ),
    );
  } else if (command === "score") {
    const scored = scoreSet(monitorDataset(store), RUNS_DIR);
    const production = productionFigures(
      JSON.parse(readFileSync(join(SET_DIR, "labels.json"), "utf-8")),
      readAnswerLines(join(RUNS_DIR, "loupe.answers.jsonl")),
      readAnswerLines(join(RUNS_DIR, "spark.answers.jsonl")),
      JSON.parse(readFileSync(join(RUNS_DIR, "loupe.warmup.json"), "utf-8")),
    );
    writeAtomic(join(RUNS_DIR, "metrics.json"), `${JSON.stringify({ ...scored, production }, null, 2)}\n`);
    console.log(JSON.stringify(production, null, 2));
  } else {
    console.error("usage: node scripts/glimmer/monitor-pages.ts build | check | dataset | loupe | spark | score");
    process.exit(2);
  }
}

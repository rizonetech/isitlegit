// The monitor's page signals counted from a real page (D05 T04 §3, correction 10, completion review G1 and round 1): the
// browser's own document tree over the protocol, which no script in the page can alter, run in Chromium over pages that
// say nothing of a form in words but hold one in their elements, and over pages that try to hide it.
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parkedPage } from "../../src/monitor/parked";
import {
  type Cdp,
  collectEvidence,
  countNodes,
  type DomNode,
  MAX_NODES,
  pageSignals,
  snapshot,
} from "../../src/monitor/signals";
import { launch } from "./browser";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => browser?.close());

// A page opened by a real navigation, then counted through the protocol as `browserCapture` does.
async function signalsOf(html: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("http://monitor.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://monitor.test/");
  const cdp = await context.newCDPSession(page);
  const signals = await pageSignals(cdp as unknown as Cdp);
  // biome-ignore lint/performance/useDomNodeTextContent: the page's `innerText` getter is what these tests are about
  const text = await page.evaluate(() => document.body.innerText);
  await context.close();
  return { signals, text };
}

const SALE = "<p>kestrelfreight.example. This domain is for sale. Sedo domain parking.</p>";
const NONE = { inputs: 0, passwords: 0, forms: 0, iframes: 0, components: 0 };

describe("page signals in Chromium", () => {
  it("counts a placeholder-only password field that names no form word in the page's text", async () => {
    const { signals, text } = await signalsOf(`${SALE}<input type="PASSWORD" placeholder="Secret">`);
    expect(signals).toEqual({ ...NONE, inputs: 1, passwords: 1 });
    // innerText cannot see the field: the page reads as a plain sale page, which only the signals refuse to park.
    expect(parkedPage(text, null, 6_000)).toEqual({ parked: false });
    expect(parkedPage(text, NONE, 6_000)).toMatchObject({ parked: true });
    expect(parkedPage(text, signals, 6_000)).toEqual({ parked: false });
  });

  it("counts a form, a frame and every kind of field a visitor can type into, and none the visitor cannot", async () => {
    const page = await signalsOf(`${SALE}
      <form><input type="text"><input type="email"><textarea></textarea><select><option>a</option></select>
      <input type="hidden" value="x"><input type="submit" value="Go"><input type="button" value="Go">
      <input type="image" alt="Go"><input type="reset"></form>
      <iframe src="about:blank"></iframe>`);
    expect(page.signals).toEqual({ ...NONE, inputs: 4, forms: 1, iframes: 1 });
  });

  // Round 2: an element that takes typing counts whatever `type` its markup claims, and a field with no form is no safer.
  it("counts a text area and a menu that claim a hidden type, with no form, so a sale page around them is screened", async () => {
    const { signals, text } = await signalsOf(
      `${SALE}<textarea type="hidden" placeholder="Secret"></textarea><select type="hidden"><option>a</option></select>`,
    );
    expect(signals).toEqual({ ...NONE, inputs: 2 });
    expect(parkedPage(text, signals, 6_000)).toEqual({ parked: false });
  });

  for (const editable of ["", "true", "plaintext-only", "nonsense"])
    it(`counts an element made editable (contenteditable="${editable}"), which takes typing with no field`, async () => {
      const { signals, text } = await signalsOf(`${SALE}<div contenteditable="${editable}">Type here</div>`);
      expect(signals?.inputs).toBe(1);
      expect(parkedPage(text, signals, 6_000)).toEqual({ parked: false });
    });

  it("does not count an element marked not editable, or the field kinds a visitor cannot type into", async () => {
    const { signals } = await signalsOf(
      `${SALE}<div contenteditable="false">Read only</div><input type="HIDDEN"><input type="submit"><input type="image" alt="Go">`,
    );
    expect(signals).toEqual(NONE);
  });

  it("counts nothing on a page with no form, so a sale page is parked", async () => {
    const { signals, text } = await signalsOf(`${SALE}<a href="https://example.test/offer">Make an offer</a>`);
    expect(signals).toEqual(NONE);
    expect(parkedPage(text, signals, 6_000)).toMatchObject({ parked: true, reason: "sedo" });
  });

  it("counts the document of a frame, and the contents of a template", async () => {
    const page = await signalsOf(`${SALE}<iframe srcdoc='<input type="password">'></iframe>`);
    expect(page.signals?.iframes).toBe(1);
    expect(page.signals?.passwords).toBe(1);
  });

  // A password field in a shadow root, with the sale words outside it and no word of a form in the page's text: the
  // hostile page of completion review G1.
  const HIDDEN = (mode: "open" | "closed", tag = "div") => `${SALE}
    <${tag} id="host"></${tag}>
    <script>
      const root = document.getElementById("host").attachShadow({ mode: "${mode}" });
      root.innerHTML = '<input type="password" placeholder="Secret">';
    </script>`;

  for (const mode of ["open", "closed"] as const)
    it(`counts a password field in a ${mode} shadow root, so a sale page around it is screened`, async () => {
      const { signals, text } = await signalsOf(HIDDEN(mode));
      expect(signals?.passwords).toBe(1);
      expect(signals?.inputs).toBe(1);
      expect(parkedPage(text, signals, 6_000)).toEqual({ parked: false });
    });

  it("counts a custom element as a component, and never parks around one", async () => {
    const { signals, text } = await signalsOf(`${SALE}<login-box></login-box>`);
    expect(signals).toEqual({ ...NONE, components: 1 });
    expect(parkedPage(text, signals, 6_000)).toEqual({ parked: false });
  });

  // Round 1: the page cannot erase its form from the counts. It patches everything an in-page counter would use,
  // and makes its closed root through another frame's pristine `attachShadow`, which no hook in this one sees.
  it("counts a closed-root form on a page that has tampered with the built-ins an in-page counter would rely on", async () => {
    const { signals, text } = await signalsOf(`${SALE}
      <div id="host"></div>
      <iframe id="realm" srcdoc="" style="display:none"></iframe>
      <script>
        const pristine = document.getElementById("realm").contentWindow.Element.prototype.attachShadow;
        // Blind everything in this realm that a script-run counter would use.
        Element.prototype.attachShadow = function () { return pristine.call(this, { mode: "closed" }); };
        Array.prototype.slice = () => [];
        Array.prototype.push = () => 0;
        Element.prototype.querySelectorAll = () => [];
        Document.prototype.querySelectorAll = () => [];
        DocumentFragment.prototype.querySelectorAll = () => [];
        Object.defineProperty(Element.prototype, "shadowRoot", { get: () => null });
        const root = pristine.call(document.getElementById("host"), { mode: "closed" });
        root.innerHTML = '<input type="password" placeholder="Secret">';
      </script>`);
    expect(signals?.passwords).toBe(1);
    expect(parkedPage(text, signals, 6_000)).toEqual({ parked: false });
  });

  it("reads an answer that is not a document as no signals, which screens the page", async () => {
    const answering = (value: unknown) => ({ send: async () => value });
    expect(await pageSignals(answering(null))).toBeNull();
    expect(await pageSignals(answering({}))).toBeNull();
    expect(await pageSignals(answering({ root: "html" }))).toBeNull();
    expect(await pageSignals({ send: async () => Promise.reject(new Error("closed")) })).toBeNull();
  });
});

describe("walking a document tree", () => {
  const chain = (length: number): DomNode => {
    const root: DomNode = { nodeName: "#document", children: [] };
    let node = root;
    for (let i = 0; i < length; i++) {
      const child: DomNode = { nodeName: "DIV", children: [] };
      (node.children as DomNode[]).push(child);
      node = child;
    }
    (node.children as DomNode[]).push({ nodeName: "INPUT", attributes: ["type", "password"] });
    return root;
  };

  it("walks a very deep tree without overflowing the stack", () => {
    expect(countNodes(chain(MAX_NODES - 10))).toMatchObject({ passwords: 1, inputs: 1 });
  });

  it("gives up on a tree past the cap, which screens the page", () => {
    expect(countNodes(chain(MAX_NODES + 10))).toBeNull();
  });

  it("counts a text area or a menu whatever type it claims, and only an input's type decides", () => {
    const field = (nodeName: string, type: string): DomNode => ({ nodeName, attributes: ["type", type] });
    expect(
      countNodes({ nodeName: "BODY", children: [field("TEXTAREA", "hidden"), field("SELECT", "submit")] }),
    ).toEqual({
      ...NONE,
      inputs: 2,
    });
    expect(countNodes({ nodeName: "BODY", children: [field("INPUT", "hidden"), field("INPUT", "image")] })).toEqual(
      NONE,
    );
    expect(countNodes({ nodeName: "BODY", children: [field("INPUT", "password")] })).toEqual({
      ...NONE,
      inputs: 1,
      passwords: 1,
    });
    expect(countNodes({ nodeName: "P", attributes: ["contenteditable", ""] })).toEqual({ ...NONE, inputs: 1 });
    expect(countNodes({ nodeName: "P", attributes: ["CONTENTEDITABLE", "False"] })).toEqual(NONE);
    // A fragment node never counts as an editable element, whatever it is given.
    expect(countNodes({ nodeName: "#document-fragment", attributes: ["contenteditable", "true"] })).toEqual(NONE);
  });

  it("leaves the browser's own shadow roots alone, and a node such as a fragment is no component", () => {
    const ua: DomNode = {
      nodeName: "#document-fragment",
      shadowRootType: "user-agent",
      children: [{ nodeName: "INPUT", attributes: ["type", "range"] }],
    };
    expect(countNodes({ nodeName: "VIDEO", shadowRoots: [ua] })).toEqual(NONE);
    // A root a script attached is walked, open or closed, and its fragment node is not counted as a component.
    for (const shadowRootType of ["open", "closed"])
      expect(
        countNodes({
          nodeName: "DIV",
          shadowRoots: [{ nodeName: "#document-fragment", shadowRootType, children: [{ nodeName: "FORM" }] }],
        }),
      ).toEqual({ ...NONE, forms: 1 });
  });

  it("finds a field wherever the protocol puts a child document", () => {
    const field: DomNode = { nodeName: "INPUT", attributes: ["TYPE", "Password"] };
    for (const place of ["shadowRoots", "pseudoElements"] as const)
      expect(
        countNodes({ nodeName: "DIV", [place]: [{ nodeName: "#document-fragment", children: [field] }] }),
      ).toMatchObject({
        passwords: 1,
      });
    for (const place of ["contentDocument", "templateContent", "importedDocument"] as const)
      expect(countNodes({ nodeName: "IFRAME", [place]: { nodeName: "#document", children: [field] } })).toMatchObject({
        passwords: 1,
      });
  });
});

// Completion review round 3: the page's own text is read last, and the structure either side of the screenshot, so a page
// whose `innerText` getter deletes its form cannot hide it from the parking decision.
describe("collecting the evidence in an order no page script can blind", () => {
  // A credential form beside the sale words, and a getter that removes the form the moment `innerText` is read.
  const HOSTILE = `<p>kestrelfreight.example. This domain is for sale. Sedo domain parking.</p>
    <form id="login"><input type="password" placeholder="Secret"></form>
    <script>
      Object.defineProperty(document.body, "innerText", {
        get() { document.body.replaceChildren(); return "This domain is for sale"; },
      });
    </script>`;

  async function open(html: string) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("http://monitor.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://monitor.test/");
    return { context, page, cdp: (await context.newCDPSession(page)) as unknown as Cdp };
  }

  it("counts the form of a page that deletes it when its text is read, because the text is read last", async () => {
    const { context, page, cdp } = await open(HOSTILE);
    const order: string[] = [];
    const evidence = await collectEvidence({
      cdp: {
        send: async (method, params) => {
          order.push("tree");
          return cdp.send(method, params);
        },
      },
      screenshot: async () => {
        order.push("screenshot");
        return new Uint8Array(await page.screenshot({ type: "jpeg" }));
      },
      text: async () => {
        order.push("text");
        // The page's own getter, which is what the page redefined; `textContent` would be the tree's, not this.
        // biome-ignore lint/performance/useDomNodeTextContent: the page's `innerText` getter is what these tests are about
        return page.evaluate(() => document.body.innerText);
      },
    });
    expect(order).toEqual(["tree", "screenshot", "tree", "text"]);
    expect(evidence.signals).toMatchObject({ forms: 1, passwords: 1, inputs: 1 });
    // The text the model reads is what the page chose to say; parking never reads it.
    expect(evidence.text).toBe("This domain is for sale");
    expect(evidence.parkText).toContain("This domain is for sale");
    expect(parkedPage(evidence.parkText ?? "", evidence.signals, 6_000)).toEqual({ parked: false });
    await context.close();
  });

  it("shows the reviewed order lost the form: reading the page's text before the structure leaves a genuinely empty body", async () => {
    const { context, page, cdp } = await open(HOSTILE);
    // biome-ignore lint/performance/useDomNodeTextContent: the page's `innerText` getter is what these tests are about
    await page.evaluate(() => document.body.innerText);
    const signals = await pageSignals(cdp);
    expect(signals).toEqual({ inputs: 0, passwords: 0, forms: 0, iframes: 0, components: 0 });
    await context.close();
  });

  it("takes the page's text from its own tree: in document order, without scripts, styles or the head", async () => {
    const { context, cdp } = await open(
      `<head><title>Hidden title</title><style>body { color: red }</style></head><body><p>First   line</p><script>var x = "script text";</script><p>Second <b>line</b></p><noscript>No script text</noscript></body>`,
    );
    const taken = await snapshot(cdp);
    expect(taken.text).toBe("First line Second line");
    await context.close();
  });

  const io = (trees: (DomNode | null)[], text = "page text") => {
    let n = 0;
    return {
      cdp: {
        send: async () =>
          trees[n] === null ? Promise.reject(new Error("gone")) : { root: trees[n++] ?? trees[trees.length - 1] },
      },
      screenshot: async () => new Uint8Array([1]),
      text: async () => text,
    };
  };
  const doc = (...children: DomNode[]): DomNode => ({ nodeName: "#document", children });
  const field: DomNode = { nodeName: "INPUT", attributes: ["type", "password"] };

  it("counts a field seen at either moment, whichever one the page hid it at", async () => {
    const early = await collectEvidence(io([doc(field), doc()]));
    const late = await collectEvidence(io([doc(), doc(field)]));
    for (const e of [early, late]) expect(e.signals).toMatchObject({ passwords: 1, inputs: 1 });
  });

  it("keeps the longer of the two texts, so a page that shortened itself between them is not taken for a short one", async () => {
    const text = (s: string): DomNode => ({
      nodeName: "P",
      children: [{ nodeName: "#text", nodeType: 3, nodeValue: s }],
    });
    const e = await collectEvidence(io([doc(text("short")), doc(text("a much longer text than the first"))]));
    expect(e.parkText).toBe("a much longer text than the first");
  });

  it("has no signals and no parking text when either reading of the tree fails, which screens the page", async () => {
    for (const trees of [[doc(), null], [null]] as (DomNode | null)[][]) {
      const e = await collectEvidence(io(trees));
      expect(e.signals).toBeNull();
      expect(e.parkText).toBeNull();
      expect(e.text).toBe("page text");
    }
  });
});

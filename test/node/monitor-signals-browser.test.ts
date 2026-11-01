// The monitor's page signals counted from a real page (D05 T04 §3, correction 10, completion review G1 and round 1): the
// browser's own document tree over the protocol, which no script in the page can alter, run in Chromium over pages that
// say nothing of a form in words but hold one in their elements, and over pages that try to hide it.
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parkedPage } from "../../src/monitor/parked";
import { type Cdp, countNodes, type DomNode, MAX_NODES, pageSignals } from "../../src/monitor/signals";
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

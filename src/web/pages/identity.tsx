// The protected identity page's routes (D05 T01 §3): `GET /protect` draws the active organisation's identity for any
// member (an owner or admin gets the forms); `POST /protect` runs one action named by its `action` field (save, logo,
// remove-logo, add-account, remove-account, confirm-remove-account) through the trust network's own functions
// (src/trust), and `GET /protect/logo` streams the logo to the organisation's members. A post must come from the app's
// own origin, from an owner or admin, on a plan that includes the identity, and name the organisation its page was
// drawn for; a form left open across an organisation switch changes nothing. A refusal that has typed values to keep
// (the save, the logo, a new account) draws the page again with the refusal on its field; any other outcome is a 303
// back to the page with what happened in the address, signed for the organisation and ten minutes. The account number
// is read, handed to `addAccount` and dropped: no answer carries it. The page is ./identity-view.tsx.
import { Hono } from "hono";
import type { GateEnv, SignedIn } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { hasFeature } from "../../auth/plans";
import { addAccount, bankKeys, maskedAccounts, removeAccount } from "../../trust/bank";
import { AccountRefused, BankKeysMissing, IdentityRefused, KeyMismatch } from "../../trust/errors";
import {
  getIdentity,
  MAX_NAME,
  MAX_NAMES,
  normaliseName,
  orgDomains,
  protectedSince,
  STALE_IDENTITY,
  setIdentity,
  verifiedAddresses,
} from "../../trust/identity";
import { MAX_LOGO_BYTES, removeLogo, storeLogo } from "../../trust/logo";
import { changePublicSlug, publicSlug, SLUG_REFUSALS } from "../../trust/public-slug";
import { errorPage, HEADERS, reference } from "./errors";
import {
  type AccountFormValues,
  type Errors,
  IdentityPage,
  IdentityPlanRefusal,
  IdentityRoleRefusal,
  type IdentityView,
  RESULTS,
  type Result,
  STALE_WORDS,
  type Typed,
  UNCERTAIN_WORDS,
} from "./identity-view";
import { memberShell } from "./member-shell";

export const identityRoutes = new Hono<GateEnv>();

const PATH = "/protect";
// The slowest honest body is a logo at its limit plus the form's other parts.
const MAX_BODY = MAX_LOGO_BYTES + 64 * 1024;

function outage(request: Request, why: string) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "identity-page", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: new URL(request.url).pathname });
}
const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });

// An action's result as the redirect carries it: signed with the auth secret over the organisation, the result and its
// moment, so the page shows only what an action of this organisation did here in the last ten minutes.
const RESULT_TTL_MS = 10 * 60_000;
const encoder = new TextEncoder();
async function sign(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`protect-result\n${text}`)));
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
const signed = (orgId: string, r: string, at: number) => [orgId, r, String(at)].join("\n");
async function back(secret: string, orgId: string, r: Result) {
  const at = Date.now();
  const query = new URLSearchParams({ r, t: String(at), s: await sign(secret, signed(orgId, r, at)) });
  return new Response(null, { status: 303, headers: { ...HEADERS, location: `${PATH}?${query}` } });
}
async function resultOf(secret: string, orgId: string, url: URL): Promise<Result | null> {
  const q = url.searchParams;
  const r = q.get("r");
  const at = Number(q.get("t"));
  if (!r || !(RESULTS as readonly string[]).includes(r) || !Number.isFinite(at)) return null;
  if (Date.now() - at > RESULT_TTL_MS || at > Date.now() + 60_000) return null;
  return q.get("s") === (await sign(secret, signed(orgId, r, at))) ? (r as Result) : null;
}

type Org = { id: string; role: string };
type Gate = { refused: Response } | { org: Org; canEdit: boolean };

// The signed-in member of the active organisation whose plan includes the identity, or the page that refuses them. A
// change also needs an owner or admin.
async function gate(env: Env, signedIn: SignedIn, request: Request, change: boolean): Promise<Gate> {
  const membership = await activeMembership(env, signedIn);
  if (!membership.ok)
    return membership.reason === "unavailable"
      ? { refused: outage(request, "membership") }
      : { refused: errorPage(403, "", { email: signedIn.user.email, closed: membership.reason === "closed" }) };
  const org = membership.org;
  const canEdit = ["owner", "admin"].includes(org.role);
  const refusal = async (draw: (shell: Awaited<ReturnType<typeof memberShell>>) => unknown, status: number) => {
    try {
      return { refused: html(draw(await memberShell(env.DB, signedIn.user, org.id, "protect")), status) };
    } catch (error) {
      return { refused: outage(request, (error as Error).name) };
    }
  };
  if (change && !canEdit)
    return refusal((shell) => <IdentityRoleRefusal shell={shell} reference={reference(403)} now={new Date()} />, 403);
  let included: boolean;
  try {
    included = await hasFeature(env.DB, org.id, "identity");
  } catch (error) {
    return { refused: outage(request, (error as Error).name) };
  }
  if (!included)
    return refusal((shell) => <IdentityPlanRefusal shell={shell} reference={reference(403)} now={new Date()} />, 403);
  return { org, canEdit };
}

// Everything the page draws, read fresh. A read that fails is an outage the caller answers, never a guessed page.
async function load(env: Env, signedIn: SignedIn, org: Org, canEdit: boolean) {
  const [shell, identity, domains, addresses, accounts, bankAvailable, slug] = await Promise.all([
    memberShell(env.DB, signedIn.user, org.id, "protect"),
    getIdentity(env.DB, org.id),
    orgDomains(env.DB, org.id),
    verifiedAddresses(env.DB, org.id),
    maskedAccounts(env.DB, org.id),
    bankKeys(env).then(
      () => true,
      (error) => {
        if (error instanceof BankKeysMissing) return false;
        throw error;
      },
    ),
    publicSlug(env.DB, org.id),
  ]);
  const since = identity?.effective.on ? await protectedSince(env.DB, org.id) : null;
  return { shell, canEdit, identity, domains, addresses, accounts, bankAvailable, since, slug } satisfies IdentityView;
}

identityRoutes.get(
  PATH,
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await gate(c.env, signedIn, c.req.raw, false);
    if ("refused" in who) return who.refused;
    try {
      const [base, result] = await Promise.all([
        load(c.env, signedIn, who.org, who.canEdit),
        resultOf(c.env.BETTER_AUTH_SECRET ?? "", who.org.id, new URL(c.req.url)),
      ]);
      return html(<IdentityPage {...base} result={result} />);
    } catch (error) {
      return outage(c.req.raw, (error as Error).name);
    }
  },
);

// The logo, to the organisation's members only: its stored type, never sniffed, never run (a sandboxed document), never kept.
identityRoutes.get(
  `${PATH}/logo`,
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    const membership = await activeMembership(c.env, c.get("signedIn"));
    if (!membership.ok)
      return membership.reason === "unavailable"
        ? outage(c.req.raw, "membership")
        : new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });
    const gone = () => new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });
    try {
      const logo = (await getIdentity(c.env.DB, membership.org.id))?.logo;
      if (!logo) return gone();
      const object = await c.env.ARTEFACTS.get(logo.key);
      if (!object) return gone();
      return new Response(object.body, {
        headers: {
          "content-type": logo.mediaType,
          "content-security-policy": "sandbox",
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    } catch (error) {
      return outage(c.req.raw, (error as Error).name);
    }
  },
);

// The post's body, read with a running count so one without a Content-Length is bounded too; null is a body that is
// not a form, "big" one over the logo's limit.
async function readForm(request: Request): Promise<FormData | "big" | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return "big";
  const chunks: Uint8Array[] = [];
  if (request.body) {
    const reader = request.body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        return "big";
      }
      chunks.push(value);
    }
  }
  const type = request.headers.get("content-type") ?? "";
  try {
    return await new Response(new Blob(chunks), { headers: { "content-type": type } }).formData();
  } catch {
    return null;
  }
}

const sentence = (reason: string) => {
  const text = reason.charAt(0).toUpperCase() + reason.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
};
const MEANWHILE = /changed meanwhile/;
const STALE = new RegExp(STALE_IDENTITY);
const isStale = (error: unknown) => error instanceof IdentityRefused && STALE.test(error.message);
// The revision a form was drawn from. Every form that changes the identity or its logo carries one, so a post that
// names none, or one that is not a number, matches no revision and is refused as stale: the services' optional check
// is for their own callers, never left off at this boundary (round 1).
function drawnVersion(raw: string): number {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : -1;
}

// The names to store: the registered name first, then the trading names (one per line, so a name may hold a comma),
// each name once as matching reads names (the first spelling kept), and no more than the ten the identity holds. A
// refusal is the words for the field.
function namesOf(registered: string, trading: string): { names: string[] } | { refusal: string } {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of [registered, ...trading.split(/\r\n|\r|\n/).map((n) => n.trim())]) {
    if (!name) continue;
    if (name.length > MAX_NAME) return { refusal: `Each name can be up to ${MAX_NAME} characters.` };
    const key = normaliseName(name);
    if (!key) return { refusal: "Each name needs letters or digits." };
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length > MAX_NAMES)
    return { refusal: `Ten names at most, counting your registered name. Remove ${names.length - MAX_NAMES}.` };
  return { names };
}

// A refusal of the save as the words for the field it is about.
function saveRefusal(reason: string): Errors {
  if (STALE.test(reason)) return { general: STALE_WORDS };
  if (MEANWHILE.test(reason))
    return {
      general: "Your identity was changed while you were editing, so nothing was saved. Check the page and save again.",
    };
  if (/protection needs/i.test(reason)) return { protection: `${sentence(reason)} Fix it, then switch protection on.` };
  if (/finance contact|financeContact/i.test(reason))
    return { contact: "Choose one of your verified sending addresses." };
  return { names: "Check the names: each needs letters or digits, and no two can be the same." };
}

identityRoutes.post(
  PATH,
  sessionGate((request) => outage(request, "session")),
  async (c) => {
    // Only the app's own pages post here: a form on another site changes nothing.
    if (c.req.header("origin") !== new URL(c.env.APP_URL).origin)
      return new Response("Forbidden", { status: 403, headers: HEADERS });
    const signedIn = c.get("signedIn");
    const who = await gate(c.env, signedIn, c.req.raw, true);
    if ("refused" in who) return who.refused;
    const { org } = who;
    const secret = c.env.BETTER_AUTH_SECRET ?? "";
    const to = (result: Result) => back(secret, org.id, result);
    const actor = signedIn.user.id;
    const form = await readForm(c.req.raw);
    // The page again, with what the refusal is about and what was typed (never an account number).
    const draw = async (extra: Partial<IdentityView>, status: number) => {
      try {
        return html(<IdentityPage {...(await load(c.env, signedIn, org, true))} {...extra} />, status);
      } catch (error) {
        return outage(c.req.raw, (error as Error).name);
      }
    };
    if (form === null) return new Response("Bad request", { status: 400, headers: HEADERS });
    if (form === "big") return draw({ errors: { logo: "The logo is larger than 2 MiB." } }, 422);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    // Drawn for another organisation than the active one (switched in another tab): nothing is done.
    if (field("org") !== org.id) return to("switched");
    const action = field("action");
    const unavailable = (what: string, error: unknown) => {
      console.log(
        JSON.stringify({ event: "identity-page", action: what, outcome: "unavailable", error: (error as Error).name }),
      );
    };
    try {
      if (action === "save") {
        const typed: Typed = {
          tradingNames: field("tradingNames"),
          contact: field("contact"),
          protected: field("protected") !== "",
          version: field("version"),
        };
        // A conflict shows what is stored now under its current revision; any other refusal keeps the revision the
        // form was drawn from, so the next save still meets the conflict check.
        const fresh = (): Typed => {
          const { version: _drawn, ...rest } = typed;
          return rest;
        };
        const registered = (
          await c.env.DB.prepare(`SELECT name FROM "organization" WHERE id = ?`).bind(org.id).first<{ name: string }>()
        )?.name;
        if (!registered) return draw({ typed, errors: { general: "Your organisation could not be read." } }, 503);
        const named = namesOf(registered, typed.tradingNames);
        if ("refusal" in named) return draw({ typed, errors: { names: named.refusal } }, 422);
        try {
          await setIdentity(
            c.env.DB,
            org.id,
            actor,
            { displayNames: named.names, financeContact: typed.contact || null, protected: typed.protected },
            new Date(),
            drawnVersion(field("version")),
          );
        } catch (error) {
          if (error instanceof IdentityRefused)
            return MEANWHILE.test(error.message) || isStale(error)
              ? draw({ typed: fresh(), errors: saveRefusal(error.message) }, 409)
              : draw({ typed, errors: saveRefusal(error.message) }, 422);
          // The write may have committed before the failure (a read after it), so the outcome is not known.
          unavailable(action, error);
          return draw({ typed, errors: { general: UNCERTAIN_WORDS } }, 503);
        }
        return to("saved");
      }
      if (action === "logo") {
        const file = form.get("logo");
        if (!(file instanceof File) || file.size === 0)
          return draw({ errors: { logo: "Choose a PNG or SVG file first." } }, 422);
        try {
          await storeLogo(
            c.env.ARTEFACTS,
            c.env.DB,
            org.id,
            actor,
            new Uint8Array(await file.arrayBuffer()),
            file.type,
            new Date(),
            drawnVersion(field("version")),
          );
        } catch (error) {
          if (error instanceof IdentityRefused) {
            const words = isStale(error)
              ? STALE_WORDS
              : MEANWHILE.test(error.message)
                ? "The logo was changed while you were here, so nothing was saved. Check it and try again."
                : /set the identity/.test(error.message)
                  ? "Save your identity first, then add your logo."
                  : sentence(error.message);
            return draw({ errors: { logo: words } }, MEANWHILE.test(error.message) || isStale(error) ? 409 : 422);
          }
          unavailable(action, error);
          return draw({ errors: { logo: UNCERTAIN_WORDS } }, 503);
        }
        return to("logo-saved");
      }
      if (action === "remove-logo") {
        try {
          await removeLogo(c.env.ARTEFACTS, c.env.DB, org.id, actor, new Date(), drawnVersion(field("version")));
        } catch (error) {
          if (error instanceof IdentityRefused)
            return draw(
              {
                errors: {
                  logo: isStale(error)
                    ? STALE_WORDS
                    : "The logo was changed while you were here, so nothing was removed. Check it and try again.",
                },
              },
              409,
            );
          unavailable(action, error);
          return to("unavailable");
        }
        return to("logo-removed");
      }
      if (action === "add-account") {
        const account: AccountFormValues = {
          bankName: field("bankName").trim(),
          branchCode: field("branchCode").trim(),
          holder: field("holder").trim(),
        };
        const number = field("accountNumber");
        const missing: NonNullable<Errors["account"]> = {
          ...(account.bankName ? {} : { bankName: "Enter the bank." }),
          ...(account.branchCode ? {} : { branchCode: "Enter the branch code." }),
          ...(number.trim() ? {} : { number: "Enter the account number." }),
          ...(account.holder ? {} : { holder: "Enter the account holder." }),
        };
        if (Object.keys(missing).length) return draw({ account, errors: { account: missing } }, 422);
        let keys: Awaited<ReturnType<typeof bankKeys>>;
        try {
          keys = await bankKeys(c.env);
        } catch (error) {
          if (!(error instanceof BankKeysMissing)) throw error;
          return draw({ account }, 503);
        }
        try {
          await addAccount(c.env.DB, keys, org.id, actor, {
            number,
            branchCode: account.branchCode,
            bankName: account.bankName,
            holder: account.holder,
          });
        } catch (error) {
          if (error instanceof AccountRefused) {
            const reason = error.message;
            const errors: NonNullable<Errors["account"]> = /already registered/.test(reason)
              ? { number: "This account is already registered." }
              : /7 to 11 digits/.test(reason)
                ? { number: "An account number is 7 to 11 digits." }
                : /6 digits/.test(reason)
                  ? { branchCode: "A branch code is 6 digits." }
                  : { general: "Fill in every field." };
            return draw({ account, errors: { account: errors } }, 422);
          }
          if (error instanceof KeyMismatch)
            return draw(
              {
                account,
                errors: {
                  account: {
                    general:
                      "Bank accounts are being moved to a new key, so none can be added right now. Try again in a few minutes.",
                  },
                },
              },
              409,
            );
          unavailable(action, error);
          return draw({ account, errors: { account: { general: UNCERTAIN_WORDS } } }, 503);
        }
        return to("account-added");
      }
      if (action === "change-slug") {
        // The owner's one change of the verify page's address (D05 T02 §6, correction 13): refused on the field when
        // malformed, taken or already spent, the allowance kept; an outcome not known asks for a reload.
        const wanted = field("slug").trim().toLowerCase();
        let outcome: "changed" | "unchanged";
        try {
          outcome = await changePublicSlug(c.env.DB, org.id, actor, wanted);
        } catch (error) {
          if (error instanceof IdentityRefused) {
            const words =
              error.message === SLUG_REFUSALS.taken
                ? "That address is taken. Choose another."
                : error.message === SLUG_REFUSALS.spent
                  ? "Your public page address has already been changed once, so it cannot change again."
                  : error.message === SLUG_REFUSALS.none
                    ? "Switch protection on first: your public page address is given then."
                    : "Use 3 to 60 lower-case letters, digits and hyphens, starting and ending with a letter or digit.";
            return draw({ slugTyped: wanted, errors: { slug: words } }, 422);
          }
          unavailable(action, error);
          return draw({ slugTyped: wanted, errors: { slug: UNCERTAIN_WORDS } }, 503);
        }
        // The address as it is, sent again, changes nothing and keeps the one change unspent (completion review).
        return to(outcome === "unchanged" ? "slug-unchanged" : "slug-changed");
      }
      if (action === "remove-account") {
        const found = (await maskedAccounts(c.env.DB, org.id)).find((a) => a.id === field("accountId"));
        if (!found) return to("account-gone");
        return draw({ confirm: found }, 200);
      }
      if (action === "confirm-remove-account") {
        try {
          await removeAccount(c.env.DB, org.id, actor, field("accountId"));
        } catch (error) {
          if (error instanceof AccountRefused) return to("account-gone");
          unavailable(action, error);
          return to("unavailable");
        }
        return to("account-removed");
      }
      return to("unavailable");
    } catch (error) {
      unavailable(action, error);
      return to("unavailable");
    }
  },
);

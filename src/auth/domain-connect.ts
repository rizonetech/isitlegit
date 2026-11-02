// Domain Connect (D07 T04 §5): how a claimed domain's registrar can add the `_isitlegit` TXT record itself after
// the owner approves, so no DNS value is typed by hand. Discovery reads the domain's `_domainconnect` TXT record
// over the same DoH transport as the claim check, learns the provider's settings, and asks the provider whether
// it supports IsItLegit's exact template: only that yes offers Connect, so an unsupported template or a provider
// that cannot answer falls back to the manual and emailed ways with no dead control. The hand-off URL carries the
// claim's whole verification value and is RSA-signed, so a provider can refuse a link whose token was changed.
import { DOH_DEADLINE_MS, DOH_URL } from "./domains";

export type ConnectFetch = (input: string, init?: RequestInit) => Promise<Response>;

type ConnectOptions = { fetchImpl?: ConnectFetch; dohUrl?: string; deadlineMs?: number };

export type ConnectDiscovery =
  | {
      state: "supported";
      providerName: string;
      apiBase: string;
      syncUrl: string;
      asyncUrl: string | null;
    }
  | { state: "unsupported" }
  | { state: "unavailable"; reason: string };

const unavailable = (reason: string): ConnectDiscovery => ({ state: "unavailable", reason });

async function readJson(
  fetchImpl: ConnectFetch,
  url: string,
  deadlineMs: number,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(deadlineMs),
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, body: (await response.json()) as unknown };
}

export async function discoverConnect(domain: string, opts: ConnectOptions = {}): Promise<ConnectDiscovery> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadlineMs = opts.deadlineMs ?? DOH_DEADLINE_MS;
  let answers: string[];
  try {
    const url = `${opts.dohUrl ?? DOH_URL}?${new URLSearchParams({ name: `_domainconnect.${domain}`, type: "TXT" })}`;
    const response = await fetchImpl(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (!response.ok) return unavailable(`DNS answered ${response.status}`);
    const body = (await response.json()) as { Status?: unknown; Answer?: { type?: number; data?: string }[] };
    if (body.Status === 3) return { state: "unsupported" };
    if (body.Status !== 0) return unavailable(`DNS status ${String(body.Status)}`);
    answers = (body.Answer ?? [])
      .filter((a) => a.type === 16)
      .map((a) => (a.data ?? "").replace(/"\s*"/g, "").replace(/"/g, "").trim())
      .filter((value) => value.length > 0);
  } catch (error) {
    return unavailable((error as Error).name);
  }
  const host = answers[0];
  if (!host) return { state: "unsupported" };
  const apiBase = (host.startsWith("http") ? host : `https://${host}`).replace(/\/$/, "");
  try {
    const settings = await readJson(fetchImpl, `${apiBase}/v2/${domain}/settings`, deadlineMs);
    if (!settings.ok) return unavailable(`provider settings answered ${settings.status}`);
    const body = settings.body as { providerName?: unknown; urlSyncUX?: unknown; urlAsyncUX?: unknown };
    if (typeof body.providerName !== "string" || typeof body.urlSyncUX !== "string")
      return unavailable("provider settings incomplete");
    return {
      state: "supported",
      providerName: body.providerName,
      apiBase,
      syncUrl: body.urlSyncUX,
      asyncUrl: typeof body.urlAsyncUX === "string" ? body.urlAsyncUX : null,
    };
  } catch (error) {
    return unavailable((error as Error).name);
  }
}

// The provider's own answer for one exact template: yes, no, or it could not answer (which reads as unavailable,
// never as a no, so a provider outage does not strike a registrar off the list).
export type TemplateSupport = { state: "yes" } | { state: "no" } | { state: "unavailable"; reason: string };

export async function templateSupport(
  discovery: Extract<ConnectDiscovery, { state: "supported" }>,
  providerId: string,
  serviceId: string,
  opts: ConnectOptions = {},
): Promise<TemplateSupport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadlineMs = opts.deadlineMs ?? DOH_DEADLINE_MS;
  try {
    const query = new URLSearchParams({ providerId, serviceId });
    const response = await fetchImpl(`${discovery.apiBase}/v2/domainTemplates?${query}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (response.status === 200) return { state: "yes" };
    if (response.status === 404) return { state: "no" };
    return { state: "unavailable", reason: `provider answered ${response.status}` };
  } catch (error) {
    return { state: "unavailable", reason: (error as Error).name };
  }
}

// IsItLegit's published Domain Connect identity (data/domain-connect/): the template's provider and service ids
// and the DNS host that carries its public key.
export const CONNECT_PROVIDER_ID = "isitlegit.co.za";
export const CONNECT_SERVICE_ID = "verify";
export const CONNECT_KEY_HOST = "_domainconnect.isitlegit.co.za";

// The signing key from its PKCS8 PEM (the Worker secret); a key that does not read refuses the hand-off, which
// the routes answer by not offering Connect.
export async function importSigningKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("the Domain Connect signing key is empty");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// The signed hand-off: the provider applies IsItLegit's template with the claim value substituted, then returns
// the owner to `redirectUri`. The signature covers the query ahead of `sig`; a link whose token was changed no
// longer verifies against the published key. The private key arrives from the Worker's secret, never from code.
export async function buildApplyUrl(input: {
  discovery: Extract<ConnectDiscovery, { state: "supported" }>;
  providerId: string;
  serviceId: string;
  domain: string;
  txtValue: string;
  redirectUri: string;
  state?: string;
  privateKey: CryptoKey;
  keyHost: string;
}): Promise<string> {
  const params = new URLSearchParams({
    domain: input.domain,
    txtValue: input.txtValue,
    redirect_uri: input.redirectUri,
  });
  if (input.state) params.set("state", input.state);
  const query = params.toString();
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", input.privateKey, new TextEncoder().encode(query)),
  );
  const apply = `${input.discovery.syncUrl.replace(/\/$/, "")}/v2/domainTemplates/providers/${encodeURIComponent(input.providerId)}/services/${encodeURIComponent(input.serviceId)}/apply`;
  return `${apply}?${query}&sig=${base64Url(signature)}&key=${encodeURIComponent(input.keyHost)}`;
}

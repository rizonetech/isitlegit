// A software WebAuthn authenticator for the passkey tests (D07 T02 §2): an ES256 key per credential, `none` attestation,
// and assertions signed over authenticator data and the client data hash, as a platform authenticator makes them
// (WebAuthn Level 3 §6.1, §6.5, §7). It discovers credentials like a real one: asked with an empty allowCredentials it
// answers only from resident credentials it holds for that relying party ID, never from an ID the test hands it.

const encoder = new TextEncoder();
export const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export const fromB64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

// Just enough CBOR (RFC 8949) for an attestation object and a COSE key: integers, byte and text strings, maps.
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
const head = (major: number, n: number) => {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
};
function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

// WebCrypto signs ECDSA as r||s; WebAuthn wants the ASN.1 DER SEQUENCE of two INTEGERs.
function der(raw: Uint8Array) {
  const integer = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const trimmed = bytes.slice(i);
    const padded = (trimmed[0] as number) & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
    return concat(Uint8Array.of(0x02, padded.length), padded);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

type Credential = { id: Uint8Array; rpId: string; userHandle: Uint8Array; keys: CryptoKeyPair; resident: boolean };
type CreationOptions = {
  challenge: string;
  rp: { id: string };
  user: { id: string };
  authenticatorSelection?: { residentKey?: string };
};
type RequestOptions = { challenge: string; rpId?: string; allowCredentials?: { id: string }[] };

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class SoftAuthenticator {
  readonly credentials: Credential[] = [];

  // navigator.credentials.create(): a new key for this relying party, resident when the options require or prefer it.
  async create(options: CreationOptions, origin: string, credentialId?: Uint8Array) {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const id = credentialId ?? crypto.getRandomValues(new Uint8Array(32));
    const resident = options.authenticatorSelection?.residentKey !== "discouraged";
    const credential = { id, rpId: options.rp.id, userHandle: fromB64url(options.user.id), keys, resident };
    this.credentials.push(credential);
    const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
    const coseKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64url(jwk.x as string)],
        [-3, fromB64url(jwk.y as string)],
      ]),
    );
    const authData = concat(
      await sha256(encoder.encode(options.rp.id)),
      Uint8Array.of(FLAG_UP | FLAG_UV | FLAG_AT),
      new Uint8Array(4),
      new Uint8Array(16),
      Uint8Array.of(id.length >> 8, id.length & 0xff),
      id,
      coseKey,
    );
    const clientData = encoder.encode(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin }),
    );
    const attestation = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(attestation),
        transports: ["internal"],
      },
    };
  }

  // navigator.credentials.get(): a credential this authenticator holds for the relying party, discovered when the
  // options list none. `as` overrides what the assertion claims, to forge one: another origin, another relying party
  // ID, a signature by another key, or presence without user verification (a security key with no PIN).
  async get(
    options: RequestOptions,
    origin: string,
    as: { origin?: string; rpId?: string; signWith?: CryptoKeyPair; unverified?: boolean } = {},
  ) {
    const rpId = options.rpId as string;
    const allowed = (options.allowCredentials ?? []).map((c) => c.id);
    const credential = this.credentials.find((c) =>
      allowed.length > 0 ? c.rpId === rpId && allowed.includes(b64url(c.id)) : c.rpId === rpId && c.resident,
    );
    if (!credential) throw new Error("NotAllowedError: no credential for this relying party");
    const authData = concat(
      await sha256(encoder.encode(as.rpId ?? rpId)),
      Uint8Array.of(as.unverified ? FLAG_UP : FLAG_UP | FLAG_UV),
      new Uint8Array(4),
    );
    const clientData = encoder.encode(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: as.origin ?? origin }),
    );
    const signed = concat(authData, await sha256(clientData));
    const key = (as.signWith ?? credential.keys).privateKey;
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signed));
    return {
      id: b64url(credential.id),
      rawId: b64url(credential.id),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(der(raw)),
        userHandle: b64url(credential.userHandle),
      },
    };
  }
}

// Fictional mail for the vision steps (D03 T02): Protea Bank is not a real brand and every address ends in `.example`.
import { putAttachment, putParsed, putVisible, type Store } from "../../../src/intake/store";

// A 2x2 solid red PNG and a 2x2 solid blue PNG.
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const RED_PNG = b64(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==",
);
export const BLUE_PNG = b64(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgYPgPRmAKABf2A/1+6zfzAAAAAElFTkSuQmCC",
);

export const PHISHING_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://tracker.example/style.css">
<script>new Image().src = "https://script-ran.example/x.png"; document.title = "script ran"</script></head>
<body style="font-family:sans-serif;margin:16px">
<img src="https://logos.example/protea-bank.png" width="120" height="40" alt="Protea Bank">
<img src="cid:badge@protea" width="60" height="60" alt="badge">
<img src="https://inner.example/pixel.gif" width="1" height="1" alt="">
<h1>Your Protea Bank account is on hold</h1>
<p>Sign in to confirm your details within 24 hours.</p>
<form action="https://collect.example/post" method="post"><input name="user"><input name="pass" type="password"><button>Sign in</button></form>
<iframe src="https://framed.example/inner" width="300" height="100"></iframe>
</body></html>`;

// Laid out so a decoded screenshot shows each part: a bar that is red on a desktop and green on a phone, the remote
// logo (red) and the `cid:` badge (blue) at known places, and a script that would add a green block if it ran.
export const LAYOUT_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fff}.bar{height:50px;background:#c00}@media (max-width:600px){.bar{background:#0a0}}
img{display:block;position:absolute;left:10px;width:60px;height:40px}#logo{top:70px}#badge{top:130px}
</style></head><body><div class="bar"></div>
<img id="logo" src="https://logos.example/protea-bank.png" alt="">
<img id="badge" src="cid:badge@protea" alt="">
<script>document.write('<div style="position:absolute;left:300px;top:70px;width:60px;height:40px;background:#0f0"></div>')</script>
</body></html>`;

export const TALL_HTML = `<!doctype html><html><body style="margin:0"><div style="height:9000px;background:#ddd">tall</div></body></html>`;

export async function storeMail(
  store: Store,
  caseId: string,
  mail: {
    html?: string | null;
    text?: string | null;
    cid?: { id: string; body: Uint8Array };
    cids?: { id: string; body: Uint8Array }[];
    truncated?: { mediaType: string }[];
    omitted?: number;
  },
): Promise<void> {
  const attachments: Record<string, unknown>[] = [];
  for (const [n, c] of [...(mail.cid ? [mail.cid] : []), ...(mail.cids ?? [])].entries()) {
    const stored = await putAttachment(store, caseId, `badge${n}.png`, c.body, "image/png");
    attachments.push({
      key: stored.key,
      filename: `badge${n}.png`,
      mediaType: "image/png",
      contentId: `<${c.id}>`,
      disposition: "inline",
      charset: null,
      bytes: c.body.byteLength,
    });
  }
  await putParsed(store, caseId, {
    headers: [],
    text: mail.text ?? null,
    html: mail.html ?? null,
    attachments,
    truncated: mail.truncated ?? [],
    omitted: mail.omitted ?? 0,
    forward: { path: "inline", headersAvailable: false, otherOriginals: 0 },
  });
  if (typeof mail.text === "string") await putVisible(store, caseId, mail.text);
}

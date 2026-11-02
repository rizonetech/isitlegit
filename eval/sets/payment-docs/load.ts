// The doctored pair images as bytes inside workerd (Vite ?inline, as test/fixtures/invoices/load.ts).

import f1 from "./pair-01-doctored.png?inline";
import f0 from "./pair-01-genuine.png?inline";
import f3 from "./pair-02-doctored.png?inline";
import f2 from "./pair-02-genuine.png?inline";
import f5 from "./pair-03-doctored.png?inline";
import f4 from "./pair-03-genuine.png?inline";
import f7 from "./pair-04-doctored.png?inline";
import f6 from "./pair-04-genuine.png?inline";
import f9 from "./pair-05-doctored.png?inline";
import f8 from "./pair-05-genuine.png?inline";
import f11 from "./pair-06-doctored.png?inline";
import f10 from "./pair-06-genuine.png?inline";
import f13 from "./pair-07-doctored.png?inline";
import f12 from "./pair-07-genuine.png?inline";
import f15 from "./pair-08-doctored.png?inline";
import f14 from "./pair-08-genuine.png?inline";
import f17 from "./pair-09-doctored.png?inline";
import f16 from "./pair-09-genuine.png?inline";
import f19 from "./pair-10-doctored.png?inline";
import f18 from "./pair-10-genuine.png?inline";
import f21 from "./pair-11-doctored.png?inline";
import f20 from "./pair-11-genuine.png?inline";
import f23 from "./pair-12-doctored.png?inline";
import f22 from "./pair-12-genuine.png?inline";
import f25 from "./pair-13-doctored.png?inline";
import f24 from "./pair-13-genuine.png?inline";
import f27 from "./pair-14-doctored.png?inline";
import f26 from "./pair-14-genuine.png?inline";
import f29 from "./pair-15-doctored.png?inline";
import f28 from "./pair-15-genuine.png?inline";
import f31 from "./pair-16-doctored.png?inline";
import f30 from "./pair-16-genuine.png?inline";
import f33 from "./pair-17-doctored.png?inline";
import f32 from "./pair-17-genuine.png?inline";
import f35 from "./pair-18-doctored.png?inline";
import f34 from "./pair-18-genuine.png?inline";
import f37 from "./pair-19-doctored.png?inline";
import f36 from "./pair-19-genuine.png?inline";
import f39 from "./pair-20-doctored.png?inline";
import f38 from "./pair-20-genuine.png?inline";

const bytes = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));

export const paymentDocImages: Record<string, Uint8Array> = {
  "pair-01-genuine.png": bytes(f0),
  "pair-01-doctored.png": bytes(f1),
  "pair-02-genuine.png": bytes(f2),
  "pair-02-doctored.png": bytes(f3),
  "pair-03-genuine.png": bytes(f4),
  "pair-03-doctored.png": bytes(f5),
  "pair-04-genuine.png": bytes(f6),
  "pair-04-doctored.png": bytes(f7),
  "pair-05-genuine.png": bytes(f8),
  "pair-05-doctored.png": bytes(f9),
  "pair-06-genuine.png": bytes(f10),
  "pair-06-doctored.png": bytes(f11),
  "pair-07-genuine.png": bytes(f12),
  "pair-07-doctored.png": bytes(f13),
  "pair-08-genuine.png": bytes(f14),
  "pair-08-doctored.png": bytes(f15),
  "pair-09-genuine.png": bytes(f16),
  "pair-09-doctored.png": bytes(f17),
  "pair-10-genuine.png": bytes(f18),
  "pair-10-doctored.png": bytes(f19),
  "pair-11-genuine.png": bytes(f20),
  "pair-11-doctored.png": bytes(f21),
  "pair-12-genuine.png": bytes(f22),
  "pair-12-doctored.png": bytes(f23),
  "pair-13-genuine.png": bytes(f24),
  "pair-13-doctored.png": bytes(f25),
  "pair-14-genuine.png": bytes(f26),
  "pair-14-doctored.png": bytes(f27),
  "pair-15-genuine.png": bytes(f28),
  "pair-15-doctored.png": bytes(f29),
  "pair-16-genuine.png": bytes(f30),
  "pair-16-doctored.png": bytes(f31),
  "pair-17-genuine.png": bytes(f32),
  "pair-17-doctored.png": bytes(f33),
  "pair-18-genuine.png": bytes(f34),
  "pair-18-doctored.png": bytes(f35),
  "pair-19-genuine.png": bytes(f36),
  "pair-19-doctored.png": bytes(f37),
  "pair-20-genuine.png": bytes(f38),
  "pair-20-doctored.png": bytes(f39),
};

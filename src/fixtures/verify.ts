// What the live fixtures host must do (D02 T07 §2), asked of any `fetch`: the deploy script asks the live host, the Worker
// test asks the Worker, so the one list of expectations is proven where it can run.
export const HOST = "https://fixtures.isitlegit.co.za";
export type Check = { name: string; ok: boolean };

export async function verifyFixtures(prefix: string, fetcher: typeof fetch = fetch, host = HOST): Promise<Check[]> {
  const get = (path: string) => fetcher(`${host}${path}`, { redirect: "manual" });
  const checks: Check[] = [];
  const check = async (name: string, test: () => Promise<boolean>) => {
    let ok = false;
    try {
      ok = await test();
    } catch {
      ok = false;
    }
    checks.push({ name, ok });
  };
  await check("robots.txt disallows everything", async () => {
    const a = await get("/robots.txt");
    return a.status === 200 && (await a.text()).includes("Disallow: /");
  });
  await check("no prefix is a 404 with noindex", async () => {
    const a = await get("/chain/1");
    return a.status === 404 && /noindex/.test(a.headers.get("x-robots-tag") ?? "");
  });
  await check("the chain redirects twice then leaves the host", async () => {
    const one = await get(`/${prefix}/chain/1`);
    const two = await get(new URL(one.headers.get("location") ?? "", host).pathname);
    return (
      one.status === 302 &&
      two.status === 301 &&
      two.headers.get("location") === "https://example.org/" &&
      /noindex/.test(one.headers.get("x-robots-tag") ?? "")
    );
  });
  await check("the same-site chain ends on a page", async () => {
    const one = await get(`/${prefix}/same/1`);
    const two = await get(new URL(one.headers.get("location") ?? "", host).pathname);
    const end = await get(new URL(two.headers.get("location") ?? "", host).pathname);
    return (
      one.status === 302 &&
      two.status === 301 &&
      end.status === 200 &&
      /noindex/.test(end.headers.get("x-robots-tag") ?? "")
    );
  });
  await check("the fynbos-lookalike login page answers with noindex", async () => {
    const slashless = await get(`/${prefix}/fynbos-lookalike`);
    const page = await get(`/${prefix}/fynbos-lookalike/`);
    const html = await page.text();
    return (
      slashless.status === 301 &&
      slashless.headers.get("location") === `/${prefix}/fynbos-lookalike/` &&
      page.status === 200 &&
      /noindex/.test(page.headers.get("x-robots-tag") ?? "") &&
      html.includes("Fynbos Freight") &&
      html.includes('name="fixture" value="fynbos-lookalike"')
    );
  });
  return checks;
}

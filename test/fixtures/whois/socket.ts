import type { Connect } from "../../../src/checks/whois";

// A socket double for ZACR's WHOIS (D02 T03 §9): what the server writes back, a stream that never ends ("hang"), or a
// failure at each stage (a refused connect, a failed `opened`, write or read), with the queries sent, the hosts asked
// and how often it was closed. A failed stage also rejects `closed`, as a Workers socket does.
type Mode = "hang" | "refuse" | "fail-open" | "fail-write" | "fail-read";
export function fakeConnect(answer: string | Uint8Array | Mode) {
  const seen = { queries: [] as string[], hosts: [] as string[], closed: 0 };
  const failing = answer === "fail-open" || answer === "fail-write" || answer === "fail-read";
  const open = ((address: { hostname: string; port: number }) => {
    seen.hosts.push(`${address.hostname}:${address.port}`);
    if (answer === "refuse") throw new Error("connection refused");
    let cancel: () => void = () => {};
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        cancel = () => {
          try {
            controller.error(new Error("closed"));
          } catch {}
        };
        if (answer === "hang" || answer === "fail-open" || answer === "fail-write") return;
        if (answer === "fail-read") {
          controller.enqueue(new TextEncoder().encode("Domain Name: "));
          controller.error(new Error("connection reset"));
          return;
        }
        const bytes = typeof answer === "string" ? new TextEncoder().encode(answer) : answer;
        for (let i = 0; i < bytes.length; i += 4096) controller.enqueue(bytes.subarray(i, i + 4096));
        controller.close();
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (answer === "fail-write") throw new Error("broken pipe");
        seen.queries.push(new TextDecoder().decode(chunk));
      },
    });
    return {
      readable,
      writable,
      close: async () => {
        seen.closed++;
        cancel();
      },
      closed: failing ? Promise.reject(new Error("socket failed")) : Promise.resolve(),
      opened: answer === "fail-open" ? Promise.reject(new Error("connect failed")) : Promise.resolve({}),
    };
  }) as unknown as Connect;
  return { open, seen };
}

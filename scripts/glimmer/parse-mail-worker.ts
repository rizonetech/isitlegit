// One message parsed in a worker thread (D03 T04 §7): the importer gives it the bytes and a deadline, and terminates
// the thread when the deadline passes, so a hostile message cannot keep parsing after it is recorded as late.
import { parentPort } from "node:worker_threads";
import PostalMime from "postal-mime";

parentPort?.on("message", async (bytes: Uint8Array) => {
  try {
    parentPort?.postMessage({ email: await PostalMime.parse(bytes) });
  } catch (error) {
    parentPort?.postMessage({ error: (error as Error).message });
  }
});

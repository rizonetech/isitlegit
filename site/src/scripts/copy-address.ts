// Shows the Copy address buttons where the browser has a clipboard and wires each to its address and announcer.
// Without this script the buttons stay hidden and the address stays selectable text.
import { copy } from "./copy.ts";

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  const status = document.getElementById(button.dataset.status ?? "");
  const address = button.dataset.copy ?? "";
  if (!navigator.clipboard || !status || !address) continue;
  button.hidden = false;
  button.addEventListener("click", async () => {
    status.textContent = "";
    status.textContent = await copy(navigator.clipboard, address);
  });
}

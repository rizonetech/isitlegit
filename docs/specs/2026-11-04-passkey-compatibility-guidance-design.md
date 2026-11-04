# Passkey compatibility and second-line recovery

D07 T02 §30 companion prepared under coordinator authority 2026-11-04T09:58:13UTC. This is a proposed A1 wording change pending exact coordinator approval and incorporation. Console owns PasskeyHelp and its browser proof; coordinator owns design/SPEC.md. No authentication, credential storage, WebAuthn negotiation or recovery policy changes.

## Sources and limits

Checked 2026-11-04. [Google's platform documentation](https://developers.google.com/identity/passkeys/supported-environments) documents Chrome cross-device authentication on its supported platforms, Chrome on Android 9+ and iOS/iPadOS 16+, and provider differences. These are platform capabilities, not a tested IsItLegit device matrix or a promise that every managed/OEM device permits the ceremony. The Google Account help page's browser-version minima describe that service; they are not copied as universal IsItLegit support requirements.

[Apple's Keychain setup guide](https://support.apple.com/en-us/109016), dated 2026-10-01, gives iCloud password-sync settings and says turning sync off can leave local passkeys. Therefore missing sync is a possible cause of a missing credential, not proof that all passkeys are unusable. The user must select the provider holding the existing credential; enabling a different provider does not move it. [Google's passkey help](https://support.google.com/accounts/answer/13548313?hl=en) notes some operating systems and browsers restrict passkeys in private windows. The proposed wording is conditional, with a normal-window retry and existing email recovery.

## Proposed exact A1 treatment

Preserve the existing Three usual causes heading and three list items, phone/QR guidance, retry and email recovery controls. Within the same PasskeyHelp container, add these visible paragraphs using existing text and spacing tokens:

**Phone and computer compatibility**

"Google documents phone-passkey sign-in in current Chrome on Windows, macOS, Linux and ChromeOS, using a nearby Android phone (Android 9 or later) or iPhone/iPad (iOS/iPadOS 16 or later). Keep Bluetooth on on both devices and choose the QR code option. Other browser, password-manager and managed-device support varies. If the option is missing, use an email link."

**Two more things to check**

- "A saved passkey may not have synced: check the password manager where you saved it. For a missing iCloud-synced passkey on iPhone, open Settings, your name, iCloud, Passwords (Passwords and Keychain on iOS 17 or earlier), then turn on Sync this iPhone. A passkey kept only on another device needs that device or an email link."
- "A private or incognito window can restrict passkeys on some browsers. Try a normal window, or use an email link."

These are troubleshooting possibilities, not detection results. Do not imply that switching off sync deletes local passkeys, that enabling iCloud finds a credential held elsewhere, or that a normal window repairs a missing or revoked credential. No device fingerprinting, browser sniffing, platform settings changes or external navigation is added.

## Proof and reversal

Extend test/node/passkey-signin-browser.test.tsx with failing-first exact compatibility/provider/private-window assertions at 360 px in both themes in the active prompt, after cancellation and after server refusal. Preserve the existing three causes and prove keyboard email recovery still reaches the link result. Keep the ceremony pending deterministically in the harness while reading both themes, then resolve/cancel it; avoid relying on a short elapsed-time delay for the new check. Run the full section checkpoint, existing passkey accessibility tests, typecheck, lint, dry build, publication and design checks. A removed new paragraph must fail the regression. Stubbed Chromium proves rendered guidance and recovery wiring only, not a live cross-device ceremony or vendor settings UI.

Reversal removes only these additional paragraphs in an ordinary corrective commit. No account, passkey, session or stored record changes.

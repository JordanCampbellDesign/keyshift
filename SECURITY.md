# Security

Please report security problems privately through GitHub's "Report a vulnerability" button on the Security tab, not in a public issue.

## How Keyshift limits access

- Keyshift only runs on a tab when you open its popup on that tab. It uses `activeTab`, so it gets no access to other sites in the background.
- Host access is optional. Keyshift asks for access to one site only when you click **Separate**, so it can download that page's audio file for stem separation.
- Audio stays on your computer. Pitch shifting and stem separation run in your browser. The Demucs model ships inside the extension.
- Keyshift has no analytics and no server. It sends nothing to the internet except the audio download above.
- Settings and separated stems are stored in the browser (`chrome.storage.local` and IndexedDB). The stem cache is capped at 500 MB.
- The extension pages use a strict content security policy. Only the extension's own scripts can run, plus WebAssembly for the model.

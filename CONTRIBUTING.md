# Contributing to Keyshift

Thanks for helping. Bug reports, site compatibility notes, and pull requests are all welcome.

## Set up

1. Clone the repo.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension` folder.
4. After you change a file, click the reload button on the Keyshift card.

There is no build step and there are no dependencies. The extension runs as plain JavaScript.

## Where things are

- `extension/background.js`: the service worker. It tracks the captured tab and routes messages.
- `extension/content.js`: runs in the page. It finds the audio or video element and controls playback and loops.
- `extension/popup.html`, `popup.js`, `css/popup.css`: the popup.
- `extension/offscreen.js`: owns the audio graph. Chrome only allows tab capture audio in an offscreen document.
- `extension/pitch-shifter-processor.js`: the AudioWorklet that shifts pitch (SoundTouch).
- `extension/stem-*.js`, `demucs-worker.js`: stem separation. The Demucs model runs in a Web Worker with WebAssembly.

## Debugging

Each part logs with a tag: `[KS:bg]`, `[KS:content]`, `[KS:popup]`, and `[KS:offscreen]`.

- Service worker logs: click **service worker** on the Keyshift card in `chrome://extensions`.
- Offscreen logs: click **offscreen.html** under "Inspect views" on the same card.
- Popup logs: right-click the popup and choose **Inspect**.

## Before you open a pull request

- Run `scripts/check.sh`. It checks every script's syntax and the manifest.
- Keep changes small and focused on one thing.
- Match the style of the file you change. Comments explain why, not what.
- For UI changes, add a before and after image of the popup.
- For site fixes, name the site and the browser version.

## Report a site that doesn't work

Open an issue with the "Site compatibility" template. Include the site, what works, and what doesn't.

## Releases

1. Update `version` in `extension/manifest.json`.
2. Add a section for that version to `CHANGELOG.md`.
3. Run the **Release** workflow in the Actions tab with the same version. It packages `keyshift-<version>.zip` and publishes the release.

To build the zip on your own Mac, run `scripts/package.sh`.

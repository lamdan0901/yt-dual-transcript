# YouTube Translate & Speak

A Chrome extension that translates YouTube video captions in real-time with a bilingual overlay — supporting 90+ languages, text-to-speech, and full display customization.

## Features

- **Real-time translation** — Detects and translates captions as they appear, with local caching to avoid redundant API calls
- **Bilingual overlay** — Displays original and translated text simultaneously on the video player
- **Text-to-speech** — Reads translated captions aloud using the browser's built-in TTS engine
- **Speech-to-text (optional)** — Generates captions from audio via Soniox API for videos without subtitles
- **SRT export** — Downloads full subtitle history as an `.srt` file with both source and translated text
- **Adaptive positioning** — Overlay adjusts automatically based on YouTube player controls visibility
- **Deep customization** — Font size, text color, background opacity, bold styles, and per-language scale factors

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. The extension icon will appear in your toolbar

No build step required — pure HTML, CSS, and JavaScript.

## Usage

1. Open any YouTube video with captions
2. Click the extension icon to open the popup
3. Select your **source** and **target** languages
4. Click **Translate** — translated captions appear as an overlay on the video
5. Adjust styling, toggle TTS, or export subtitles as needed

## Configuration

All settings persist via `chrome.storage.local`.

| Option | Description |
|---|---|
| Source language | Auto-detect or manually specify the caption language |
| Target language | Language to translate into (90+ supported) |
| Font size | Caption text size (12–48px) |
| Text color | Hex color picker for caption text |
| Background opacity | Overlay background transparency (0–100%) |
| Bold style | Bold source, target, or both |
| Source / target scale | Individual size multipliers (0.5×–2×) |
| Hide original | Show translated text only |
| Adaptive position | Auto-adjust overlay when player controls appear |
| TTS | Read translated captions aloud |
| STT (Soniox) | Generate captions from audio (requires API key) |

## Tech Stack

- **Manifest V3** Chrome Extension
- **Vanilla JavaScript** — no frameworks or build tools
- **Google Translate API** (free tier) for translations
- **Chrome TTS API** for speech synthesis
- **Chrome Storage API** for settings persistence
- **Soniox API** (optional) for speech-to-text

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Save settings and translation cache |
| `tts` | Text-to-speech synthesis |
| `tabCapture` | Capture tab audio for STT |
| `youtube.com` | Inject caption overlay |
| `translate.googleapis.com` | Translation API access |
| `api.soniox.com` | Speech recognition (optional) |

## Project Structure

```
gem-ext/
├── manifest.json   # Extension manifest (MV3)
├── popup.html      # Popup UI
├── popup.js        # Popup logic and settings
├── popup.css       # Popup styles
├── content.js      # YouTube page content script
└── background.js   # Service worker (translation, TTS, messaging)
```

## Notes

- Works on YouTube videos that have captions enabled (auto-generated or manual)
- Translation uses Google's free translate endpoint — no API key required
- STT feature requires a [Soniox](https://soniox.com) API key entered in the popup
- The extension follows YouTube's SPA navigation, so it works across page transitions without reload

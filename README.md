# ClipForge AI 0.2

A browser-based video clip editor designed for mobile-first use.

## Current features
- Upload a local video file (up to 700 MB; practical limits depend on device memory).
- Preview the video and choose a start/end time.
- Generate Hindi or English speech captions in the browser with Transformers.js and Whisper.
- Edit caption text and download captions as an SRT file.
- Export a 9:16, 1080 × 1920 MP4 using FFmpeg.wasm.

## Important limitations
- This version does **not** download arbitrary YouTube links. Upload a video you own or have permission to edit.
- Automatic highlight detection is not implemented yet. You choose the clip range manually.
- Captions are exported as a separate SRT file. They are previewed in the editor but are not burned into the MP4 in this version.
- The speech model downloads on first use and can be slow on mobile. Video export and transcription can exceed the memory available on some phones. Short clips are more reliable.
- Video and audio processing is intended to happen in the browser. Model files are fetched from Hugging Face and FFmpeg core files from jsDelivr.

## Local development
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
```
The production site is generated in `dist/`.

## Cloudflare Pages
- Connect this GitHub repository.
- Production branch: `main`
- Framework preset: `Vite`
- Build command: `npm run build`
- Build output directory: `dist`

This project is an early beta. Test with a short sample video before using a long stream recording.

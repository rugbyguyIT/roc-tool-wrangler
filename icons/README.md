# Icons — branding swap point 3 of 4

These are **placeholders** carried over from the sibling 8 Second Rides app so the
PWA installs and renders correctly today. Replace all four when the real logo lands:

| File | Size | Used by |
|---|---|---|
| `icon-192.png` | 192×192 | `manifest.json`, Android home screen |
| `icon-512.png` | 512×512 | `manifest.json`, splash screens |
| `apple-touch-icon.png` | 180×180 | iOS home screen |
| `favicon-32.png` | 32×32 | browser tab |

After replacing them, **bump the `?v=N` query string** on every icon reference in
`manifest.json` and in each page's `<head>` — otherwise phones that already installed
the app keep showing the old icon indefinitely.

`/login-logo.png` (repo root, not this folder) is the mark inside the login orb.
Keep it under ~200KB; it is the first image a user downloads, often on venue wifi.
The login page falls back to a Font Awesome glyph if the file is missing, so a bad
logo file degrades rather than breaking the page.

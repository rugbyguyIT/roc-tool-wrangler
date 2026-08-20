// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — app identity.
//
// BRANDING SWAP POINT 1 of 4. Nothing else in the app hardcodes the
// app name: every <title>, nav wordmark and footer is written from
// APP_NAME at runtime (see brandPage() in js/api.js). The other three
// swap points are css/brand.css, icons/* + manifest.json, and
// login-logo.png.
//
// Bump APP_VERSION and CACHE_VERSION in sw.js together on every release
// — that pair is what forces every client to pick up new JS/CSS.
// ─────────────────────────────────────────────────────────────
// These are the FALLBACK, used on the login page and before the first
// settings fetch. The live name is app_settings.app_display_name, edited
// in Admin → Settings; see applyBrand() in js/api.js.
const APP_NAME = 'HLSR Asset Tracker';
const APP_SHORT = 'HLSR Assets';
const APP_ORG = 'Houston Livestock Show and Rodeo™';
const APP_VERSION = '0.17.0';

# website/ — Botiny marketing page

Static waitlist and marketing page for Botiny, added 16 October 2026. It is **not** the API, dashboard or portal.

## What's here

- `public/index.html` — the page Firebase Hosting serves (`firebase.json` `hosting.public` is `public/`)
- `index.html` — a copy of the same file at the folder root
- `.firebaserc` — Firebase project `botiny-78823`
- `public/favicon.svg` and `public/favicon.ico` — canonical Botiny mark (added 23 November 2026)

The page uses Tailwind from a CDN, Space Grotesk and Inter, and a sprout-and-ring mark in the same family as [`../assets/brand/`](../assets/brand/). Waitlist forms post to Web3Forms. Do not commit new third-party access keys; the keys already in the HTML were part of the 16 October commit and should be treated as public form endpoints, not rotated in this documentation.

## Local preview

```bash
# from website/public
python3 -m http.server 8080
```

Deploy is a Firebase Hosting publish of `public/`. This folder has no build step and no Node toolchain.

The API and this marketing page are separate. Feature work on the marketplace is paused; this page can still be published on its own.

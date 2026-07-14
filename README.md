# Cadence — installable iPhone app

A standalone version of the Cadence cycle tracker. It runs entirely in the
browser, stores everything on the device (IndexedDB), and installs to the
iPhone home screen as a Progressive Web App (PWA). No account, no server,
no data leaves the phone.

## What's in this folder
- `index.html`, `app.js` — the app (app.js is already built; no build step needed)
- `manifest.webmanifest`, `sw.js`, `icons/` — what makes it installable + offline
- `Cadence.source.jsx` — the React source, if you want to edit and rebuild

## Fastest way to publish it (free HTTPS host)

A PWA must be served over **https** to install. Any of these work; pick one.

### Option A — Netlify Drop (no account math, ~2 minutes)
1. Go to https://app.netlify.com/drop
2. Drag this whole folder onto the page.
3. It returns a URL like `https://something.netlify.app`. That's the app.

### Option B — Cloudflare Pages (free, custom-ish subdomain)
1. Create a free Cloudflare account → Workers & Pages → Create → Pages → Direct Upload.
2. Upload this folder. It publishes to a `*.pages.dev` URL.

### Option C — GitHub Pages (since you already live in GitHub)
1. New repo, e.g. `cadence`. Upload these files to the root.
2. Settings → Pages → Source: Deploy from branch → `main` / root.
3. App will be at `https://<user>.github.io/cadence/`.
   (Relative paths are already used, so a subpath like `/cadence/` is fine.)

## Installing it on her iPhone
1. Open the published URL in **Safari** (not Chrome — only Safari can install PWAs on iOS).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch it from the new "Cadence" icon. It opens fullscreen, works offline,
   and remembers her data.

Important iOS quirk: the installed app has its **own storage**, separate from
Safari. Have her **install first, then start logging** — entries made in Safari
before installing won't carry over into the installed app.

## Rebuilding after editing the source
```
npm install react@18 react-dom@18 recharts@2 esbuild@0.23
# entry.jsx imports storage-shim.js then Cadence.source.jsx and renders it
npx esbuild entry.jsx --bundle --minify --format=iife \
  --define:process.env.NODE_ENV='"production"' --outfile=app.js
```

## Recommended next addition
There is no backup/export yet, so all data lives only on that one phone.
Adding a "Export / Import JSON" button is the single most valuable next step
before she relies on it long-term.

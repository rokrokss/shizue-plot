# Promo images

The README's banner and feature images, and GitHub's social preview, in the
look of the sibling [shizue](https://github.com/rokrokss/shizue)'s store images.
They are HTML pages in `src/` around real screenshots of the app in `shots/`,
rendered to `out/`.

The screenshots show demo works made for them in `demo/`: five original
characters whose covers are drawn from shapes in `demo/covers.mjs`, so no
third-party art is in them, and one RisuAI chat. The model presets and keys
are made up, and the ChatGPT card is shown connected to a placeholder address.

- `out/social.png` is the repository's social preview: upload it in the GitHub
  repository's **Settings › General › Social preview**.
- To change only the wording or layout, edit `src/` and run
  `node docs/promo/render.mjs` (or `render.mjs banner` for one image).

To take the screenshots again, after a UI change:

```sh
node docs/promo/demo/covers.mjs
node docs/promo/render.mjs lighthouse neon shrine orbit academy
node docs/promo/demo/cards.mjs
```

Then start the app on a fresh folder in test mode, on a port of its own:

```sh
cd apps/plot/apps/api
BETTER_AUTH_URL=http://localhost:13470 SHIZUE_PORT=13470 CHATGPT_CALLBACK_PORT=47870 NODE_ENV=test EMBEDDER=off SHIZUE_DATA_DIR="$(mktemp -d)" pnpm exec tsx src/index.ts
```

and in another shell seed it and take the screenshots, then render:

```sh
node docs/promo/capture.mjs http://localhost:13470
node docs/promo/render.mjs
```

Both scripts use the browser suite's Playwright, and the pages load their fonts
from Google Fonts and jsDelivr.

# Nebari LGTM Pack Documentation

This directory contains the [Astro](https://astro.build) + [Starlight](https://starlight.astro.build) site for the Nebari LGTM Pack.

## Prerequisites

- Node.js `>= 22` (enforced by the `engines` field in `package.json`)
- npm (bundled with Node.js)

## Install

```bash
npm ci
```

Or from the repo root: `make docs-install`

## Local development

```bash
npm run dev
```

Starts the Astro dev server with hot reload on http://localhost:4321/.

Or from the repo root: `make docs`

## Production build

```bash
npm run build
```

Emits static files to `docs/dist/`.

Or from the repo root: `make docs-build`

## Preview the production build

```bash
npm run preview
```

Or from the repo root: `make docs-preview`

## Unit tests

```bash
npm test
```

Or from the repo root: `make docs-test`

## Link checking

```bash
make docs-check-links
```

To test with the production base path: `BASE=/lgtm-pack/ make docs-check-links`

## Content

Pages live in `src/content/docs/`. Each `.md` or `.mdx` file becomes a page. The sidebar is configured in `astro.config.mjs` under `starlight.sidebar`.

## CI

The [`docs` workflow](../.github/workflows/docs.yml) builds the site and deploys to [Cloudflare Pages](https://pages.cloudflare.com) on every push to `main`. Pull requests get a preview URL posted as a comment.

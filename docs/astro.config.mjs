import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { nebari } from '@nebari/starlight';
import rehypeMermaid from 'rehype-mermaid';
import remarkBaseLinks from './src/plugins/remark-base-links';

// Deploy conventions, set by .github/workflows/docs.yml (PACK_SLUG: lgtm-pack):
//
//   main    SITE=https://packs.nebari.dev              BASE=/lgtm-pack/
//   preview SITE=https://<branch>.lgtm-pack.pages.dev  BASE=/
//
// The `site` default mirrors the production origin so a plain `npm run build`
// still emits correct canonical URLs and a sitemap. `base` stays `/` by default
// so the dev server and local previews serve from the root.
const SITE = process.env.SITE || 'https://packs.nebari.dev';
const BASE = process.env.BASE || '/';

export default defineConfig({
  base: BASE,
  site: SITE,
  integrations: [
    starlight({
      title: 'Nebari LGTM Pack',
      description: 'Cluster observability with the Grafana LGTM stack: Loki logs, Tempo traces, Mimir metrics, and Grafana dashboards.',
      // Shared Nebari identity (brand colors, fonts, logo, favicon, footer, and
      // GitHub social link) comes from the @nebari/starlight theme plugin. On the
      // portal the header logo returns users to the pack catalog.
      plugins: [nebari({ logoHref: 'https://packs.nebari.dev/' })],
      editLink: {
        // Starlight appends the source path (src/content/docs/<file>.md) to this
        // base, so it must point at the Astro project root inside the repo.
        baseUrl: 'https://github.com/nebari-dev/lgtm-pack/edit/main/docs/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', link: '/' },
            { label: 'Getting started', link: '/getting-started/' },
            { label: 'Deploying on Nebari', link: '/deployment/' },
            { label: 'Nebari integration', link: '/nebari-integration/' },
            { label: 'Local development', link: '/local-development/' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Mimir deployment modes', link: '/mimir-modes/' },
            { label: 'OpenTelemetry wiring', link: '/otel-collector/' },
            { label: 'Dashboards', link: '/dashboards/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration', link: '/configuration/' },
            { label: 'Architecture', link: '/architecture/' },
          ],
        },
      ],
    }),
  ],
  markdown: {
    syntaxHighlight: { type: 'shiki', excludeLangs: ['mermaid'] },
    remarkPlugins: [[remarkBaseLinks, { base: BASE }]],
    rehypePlugins: [[rehypeMermaid, { strategy: 'inline-svg' }]],
  },
});

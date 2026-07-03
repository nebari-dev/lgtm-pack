import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import rehypeMermaid from 'rehype-mermaid';
import { fileURLToPath } from 'url';
import path from 'path';
import remarkBaseLinks from './src/plugins/remark-base-links';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: process.env.BASE || '/',
  site: process.env.SITE,
  integrations: [
    react(),
    starlight({
      title: 'Nebari LGTM Pack',
      description: 'Observability stack (Grafana LGTM) for Nebari.',
      logo: {
        light: './src/assets/logo.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: false,
      },
      customCss: [
        '@fontsource-variable/geist',
        '@fontsource/ibm-plex-mono',
        './src/styles/nebari-tokens.css',
        './src/styles/starlight-theme.css',
      ],
      components: {
        SocialIcons: './src/components/SocialIcons.astro',
      },
      sidebar: [
        { label: 'Introduction', slug: 'index' },
      ],
    }),
  ],
  markdown: {
    syntaxHighlight: { type: 'shiki', excludeLangs: ['mermaid'] },
    remarkPlugins: [[remarkBaseLinks, { base: process.env.BASE || '/' }]],
    rehypePlugins: [[rehypeMermaid, { strategy: 'inline-svg' }]],
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  },
});

import { defineConfig } from 'astro/config';

// Static output — the entire simulator runs client-side in WebGL2.
// `dist/` deploys directly to Cloudflare Pages (no adapter / server required).
export default defineConfig({
  output: 'static',
  site: 'https://black-hole.pages.dev',
  compressHTML: true,
  build: {
    inlineStylesheets: 'auto',
  },
});

// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Set SITE_URL (and BASE_PATH when serving from a sub-path) in CI.
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://machinewright.dev',
  base: process.env.BASE_PATH ?? '/',
  integrations: [
    starlight({
      title: 'Machinewright',
      description: 'Graph-native hardware-as-code. Design machines in Python, export CAD, BOMs and print plates.',
      logo: { src: './src/assets/mark.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/theme.css', './src/styles/docs.css'],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ambientlabscomputing/machinewright' },
      ],
      editLink: {
        baseUrl: 'https://github.com/ambientlabscomputing/machinewright/edit/main/site/',
      },
      components: {
        SiteTitle: './src/components/DocsSiteTitle.astro',
      },
      sidebar: [
        { label: 'Start here', items: [
          { label: 'Introduction', slug: 'docs' },
          { label: 'Install', slug: 'docs/install' },
          { label: 'Create a starter project', slug: 'docs/starter-project' },
          { label: 'Tour of the macOS app', slug: 'docs/app-tour' },
        ]},
        { label: 'Tutorials', autogenerate: { directory: 'docs/tutorials' } },
        { label: 'Guides', autogenerate: { directory: 'docs/guides' } },
        { label: 'Concepts', autogenerate: { directory: 'docs/concepts' } },
        { label: 'Reference', items: [
          { label: 'CLI', slug: 'docs/reference/cli' },
          { label: 'Python API', collapsed: false, autogenerate: { directory: 'docs/reference/api' } },
        ]},
        { label: 'Downloads', link: '/downloads/' },
      ],
    }),
  ],
});

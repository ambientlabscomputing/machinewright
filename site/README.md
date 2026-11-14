# Machinewright site

Astro + [Starlight](https://starlight.astro.build) site for the public landing page, downloads and documentation.

```bash
cd site
npm install
npm run dev          # http://localhost:4321
npm run build        # static output in dist/
```

## Where things live

| Path | What |
| --- | --- |
| `src/pages/index.astro` | Landing page |
| `src/pages/downloads.astro` | Downloads, built from GitHub releases |
| `src/content/docs/docs/` | Hand-written docs (install, tutorials, guides, concepts) |
| `src/content/docs/docs/reference/` | **Generated** Python API + CLI reference (do not edit) |
| `src/assets/screens/` | App screenshots (ironless-actuator project) |
| `src/data/releases.snapshot.json` | Fallback release list used when GitHub cannot be reached |

## Regenerating the API reference

From the `site/` directory:

```bash
npm run docs:api
```

This runs `scripts/generate_api_docs.py` with `uv`: griffe reads `machinewright.__all__` statically for the Python API, and the Typer app is walked for the CLI reference. Add a docstring in `src/machinewright` and regenerate to improve a page.

## Downloads

`getReleases()` in `src/lib/releases.ts` queries the GitHub releases API at build time. While the repository is private, set `GITHUB_TOKEN` for the build; otherwise the committed snapshot is used. Refresh the snapshot with:

```bash
gh api repos/ambientlabscomputing/machinewright/releases --paginate --jq '[.[]|select(.draft|not)|{tag:.tag_name,name:.name,prerelease:.prerelease,published:.published_at,url:.html_url,notes:(.body // ""),assets:[.assets[]|{name,size,url:.browser_download_url}]}]' > src/data/releases.snapshot.json
```

Rebuild the site when a release is published so the page stays current.

## Configuration

`SITE_URL` and `BASE_PATH` environment variables set the canonical URL and sub-path at build time.

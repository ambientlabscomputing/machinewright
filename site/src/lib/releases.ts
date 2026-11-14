import snapshot from '../data/releases.snapshot.json';

export interface Asset { name: string; size: number; url: string; }
export interface Release {
  tag: string; version: string; name: string; prerelease: boolean;
  published: string; url: string; notes: string; assets: Asset[];
  sha256?: string; dmg?: Asset;
}

const REPO = 'ambientlabscomputing/machinewright';

function enrich(r: any): Release {
  const assets: Asset[] = r.assets ?? [];
  return {
    tag: r.tag, version: String(r.tag).replace(/^v/, ''), name: r.name ?? r.tag,
    prerelease: !!r.prerelease, published: r.published, url: r.url,
    notes: r.notes ?? '', assets,
    dmg: assets.find((a) => a.name.endsWith('.dmg')),
  };
}

async function fetchLive(): Promise<Release[] | null> {
  // Public repos need no token; a private repo needs GITHUB_TOKEN at build time.
  const token = process.env.GITHUB_TOKEN;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any[];
    return data.filter((r) => !r.draft).map((r) => enrich({
      tag: r.tag_name, name: r.name, prerelease: r.prerelease, published: r.published_at,
      url: r.html_url, notes: r.body,
      assets: r.assets.map((a: any) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
    }));
  } catch { return null; }
}

function semverKey(v: string): [number, number, number, string] {
  const [core, pre = ''] = v.split('-');
  const [a = 0, b = 0, c = 0] = core.split('.').map(Number);
  return [a, b, c, pre];
}
function compare(a: Release, b: Release): number {
  const ka = semverKey(a.version), kb = semverKey(b.version);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return (kb[i] as number) - (ka[i] as number);
  if (ka[3] === kb[3]) return 0;
  if (!ka[3]) return -1; // stable before its own release candidates
  if (!kb[3]) return 1;
  return kb[3].localeCompare(ka[3], undefined, { numeric: true });
}

let cache: Promise<{ releases: Release[]; live: boolean }> | undefined;
export function getReleases() {
  cache ??= (async () => {
    const live = await fetchLive();
    const releases = (live ?? (snapshot as any[]).map(enrich)).sort(compare);
    return { releases, live: live !== null };
  })();
  return cache;
}

export const humanSize = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);
export const repoUrl = `https://github.com/${REPO}`;

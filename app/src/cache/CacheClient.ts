/**
 * Resolves an evaluation's mesh manifest to scoped local resource URLs, so
 * `evaluator/SnapshotInstaller` and `viewport/ViewportHost` share one place
 * that builds cache paths instead of each screen hand-building
 * `${outputDirectory}/${mesh.name}` inline (today's spikes each do this ad
 * hoc). Digest validation itself still happens natively in
 * `MachinewrightAssetsModule.meshFileURL` — this module only sequences the
 * per-mesh resolution.
 */
import type { ArtifactManifest, MeshRefLite } from "./ArtifactManifest";

export interface MeshFileResolver {
  getMeshFileURL(path: string, expectedDigest: string): Promise<string>;
}

export interface CacheClientOptions {
  readonly resolver: MeshFileResolver;
  readonly joinPath: (directory: string, name: string) => string;
}

export class CacheClient {
  private readonly resolver: MeshFileResolver;
  private readonly joinPath: (directory: string, name: string) => string;

  constructor(options: CacheClientOptions) {
    this.resolver = options.resolver;
    this.joinPath = options.joinPath;
  }

  async resolveMeshRefs(outputDirectory: string, manifest: ArtifactManifest): Promise<readonly MeshRefLite[]> {
    return Promise.all(
      manifest.meshes.map(async (mesh) => ({
        graphNodeId: mesh.graph_node_id,
        digest: mesh.digest,
        url: await this.resolver.getMeshFileURL(this.joinPath(outputDirectory, mesh.name), mesh.digest),
      })),
    );
  }
}

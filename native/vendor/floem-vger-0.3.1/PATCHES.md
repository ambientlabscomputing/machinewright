# Vendored patch: floem-vger 0.3.1

## Provenance

- **Upstream:** https://github.com/audulus/vger-rs (crate name `floem-vger`, package
  described upstream as "Unofficial vger fork for Floem")
- **Version forked from:** 0.3.1, as published to crates.io
- **License:** MIT (see `LICENSE` in this directory — unmodified from upstream)
- **Forked on:** 2026-09-11
- **Why this exists at all:** `floem` 0.2.0 (our UI framework) depends on this crate
  for its default `vger` GPU rendering backend. We hit a real, reproducible bug in it
  (see Patch 1) that we could not work around from application code — there is no
  public API to influence the atlas, so the only options were: wait for upstream,
  fork, or don't use a live-updating image in the UI at all. We chose to vendor a
  minimal patch rather than a full fork; see "Fork vs. patch" below.

This is a full, unmodified copy of the crate plus two small patches applied on top
(see `patches/`). It is **not** a from-scratch rewrite — treat it as "upstream +
two hunks," not as code we own. Keep the whole tree (tests, CI config, fonts,
everything) even though not all of it is exercised from our workspace, since the
goal is that this directory always stays diffable against a fresh upstream
checkout of the same version.

## What's patched, and why

Both patches touch only `src/glyphs.rs`, specifically the shared color/mask
texture atlas (`GlyphCache`) that vger uses to pack every glyph, SVG rasterization,
and `draw_img` image it renders into one shared GPU texture, keyed by a content
hash. The underlying allocator (`Atlas::add_region`, in `src/atlas.rs`, not
patched) is a bump/rect-packer allocator: `add_region` never frees an individual
region — the only way to reclaim space is `Atlas::clear()`, which wipes the whole
atlas (and, at the `GlyphCache` level, every hash → region lookup table with it).

### Patch 1 — `patches/0001-atlas-recover-from-pack-failure.patch`

**What:** in `get_image_mask` and `get_svg_mask`, if `Atlas::add_region` fails to
pack a new region (returns `None`), reclaim the whole atlas via `self.clear()` and
retry once, instead of accepting the failure.

**Why (the actual bug):** before this patch, a pack failure's `AtlasInfo { rect:
None, .. }` was cached forever under that content hash, with no code path that ever
retries or clears in response. Machinewright's 3D viewport renders into an 800×600
`Img` widget whose pixel content (and therefore whose peniko `Image` hash) changes
on every camera move. The old atlas was 1024×1024: once one 800×600 region was
placed, a second, differently-hashed 800×600 region is **geometrically impossible**
to pack alongside it (no free rectangle in a 1024×1024 square minus an 800×600
corner is ever ≥ 800×600 in either dimension) — so the very next frame after any
camera movement failed to pack, got cached as a permanent `None`, and the viewport
went blank and stayed blank until the app was restarted. This is a real, generic
bug: any consumer feeding vger a `draw_img`/SVG whose content changes every frame
and whose size is a non-trivial fraction of the atlas will eventually hit it,
regardless of atlas size — this patch is what makes it self-heal instead of
wedging permanently.

**Upstream PR worthiness: yes, as-is.** This is a pure correctness fix with no API
or behavior change for anyone not already hitting the bug — small diff, easy to
justify, low review burden. This is the one worth actually proposing upstream; see
below.

### Patch 2 — `patches/0002-widen-shared-atlas-size.patch`

**What:** bumps the initial atlas size in `GlyphCache::new` from 1024×1024 to
4096×4096 (~16× the area).

**Why:** Patch 1 alone fixes correctness but not performance: at 1024×1024, a
clear was needed on *every single frame* once the camera started moving, and a
clear wipes cached glyph rasterizations too — so every drag frame forced the
entire visible UI's text/icons to be re-rasterized from scratch (visibly: "the
text reloads when I drag"). At 4096×4096, roughly ~24 distinct 800×600 frames fit
before `check_usage`'s 70%-usage auto-clear triggers, turning "a stall on every
frame" into "an occasional stall during a long, fast drag." Cost: ~335MB of
additional VRAM (color atlas 4096×4096×4B ≈ 64MB, mask atlas 4096×4096×1B ≈ 16MB,
vs. ~5MB combined at the old size), which is trivial for the class of hardware
this app targets.

**Upstream PR worthiness: not as-is.** This is workload-specific tuning, not a bug
fix — quadrupling every floem app's default atlas memory footprint regardless of
whether they need it is a reasonable thing for a maintainer to push back on. If we
want to upstream this, the honest version is a constructor/config option for atlas
size (a small API addition), not a changed default. Nobody has scoped that yet.

## Fork vs. patch

We're treating this as a **vendored patch**, not an ongoing fork. That means: no
commitment to track upstream continuously, no expectation of adding more patches
unless we hit more bugs, and the intent to delete this vendor directory the moment
it's no longer needed (upstream fixes Patch 1's bug, or we stop needing an atlas
size bigger than upstream's default, or floem moves to a different rendering
backend). If this list of patches grows past two or three unrelated concerns, or
we find ourselves patching this on every floem upgrade, that's the signal to
revisit this decision — not before.

## Opening an upstream PR (Patch 1 only)

Not done yet. If/when we do:

1. Confirm https://github.com/audulus/vger-rs is still the right upstream (floem
   may have moved which fork/crate it depends on since we forked — check floem's
   current `Cargo.toml` for the `floem-vger` version and repo it points at).
2. Confirm the project is active enough for a PR to plausibly get reviewed.
3. Open a PR containing only `patches/0001-atlas-recover-from-pack-failure.patch`'s
   changes, with a description similar to the "Why (the actual bug)" section above.
   Don't include Patch 2 — it's a separate, weaker ask (see above).
4. If merged and released, bump `floem-vger` in `native/Cargo.toml`'s
   `[workspace.dependencies]`/lockfile to the fixed version, drop the
   `[patch.crates-io]` entry, and delete this vendor directory — keeping only
   Patch 2 vendored if we still want the larger atlas and it hasn't also been
   addressed upstream by then.

## Updating to a newer upstream floem-vger version

This crate is pulled in as a transitive dependency of `floem`, not something we
depend on directly, so "upgrading floem-vger" in practice means "floem bumped its
`floem-vger` dependency and we need to re-apply our patches to the new version."

1. **Get a pristine copy of the new version.** Temporarily comment out the
   `[patch.crates-io]` block in `native/Cargo.toml`, then run
   `cargo update -p floem-vger --precise <new-version> --manifest-path native/Cargo.toml`
   (or just `cargo update -p floem-vger` if picking up whatever floem now
   requires) so cargo fetches the real crate into the registry cache. Find it at
   `~/.cargo/registry/src/index.crates.io-*/floem-vger-<new-version>/`.
2. **Diff old-pristine vs. new-pristine** (i.e. the registry-cached 0.3.1 vs. the
   newly-cached version, *not* our vendored/patched copy) to see what upstream
   actually changed in `src/glyphs.rs` and `src/atlas.rs` between versions. This
   tells you whether our patches will apply cleanly or need rebasing.
3. **Replace this vendor directory's contents** with the new pristine copy
   (`cp -R` over everything except this `PATCHES.md` and the `patches/`
   subdirectory), updating the version number in the directory name and in
   `Cargo.toml`'s `name`/`version` if you're keeping the directory name in sync.
4. **Reapply the patches, in order:**
   ```
   cd native/vendor/floem-vger-<new-version>
   patch -p1 < patches/0001-atlas-recover-from-pack-failure.patch
   patch -p1 < patches/0002-widen-shared-atlas-size.patch
   ```
   If a hunk fails to apply cleanly (upstream changed the surrounding code), open
   the `.rej` file, re-apply the intent by hand against the new code, and
   regenerate the `.patch` file from the resulting diff so it stays accurate for
   next time (`diff -u --label a/src/glyphs.rs --label b/src/glyphs.rs
   <pristine> <patched> > patches/000N-....patch`).
5. **Re-point `[patch.crates-io]`** in `native/Cargo.toml` at the new directory
   path (and restore it if you commented it out in step 1).
6. **Build and test:**
   `cargo build --manifest-path native/Cargo.toml -p machinewright-floem` then
   `cargo test --manifest-path native/Cargo.toml --workspace`.
7. **Manually verify the viewport still behaves** — drag to orbit, pan, zoom —
   since the whole reason these patches exist is a bug that only shows up
   interactively, not in the automated test suite (nothing here has a unit test;
   it's a rendering pipeline defect that manifests as blank pixels on screen).
8. Delete the old version's vendor directory once the new one is confirmed working.

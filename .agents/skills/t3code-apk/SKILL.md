---
name: t3code-apk
description: "Use when building or rebuilding the user's t3code Android fork, publishing an APK,
  or providing a fresh APK download link after mobile changes."
metadata:
  type: procedure
---

# Contract

## Input Contract

- The requested fix or revision, its verified checkout, and permission to distribute the APK.
- The existing Android toolchain, installed project dependencies, Git, Node, Bash, tmux, and `gh`.
- The destination GitHub repository, release tag, and a unique asset name before publication.
- The previous APK's signing certificate when installation over an existing app is required.

## Output Contract

- A self-contained, signed Preview release APK that does not require Metro.
- Build provenance, SHA-256, package identity, signature verification, and the build exit code.
- A verified direct GitHub release-asset download URL when distribution was requested.
- Explicit limitations for uncommitted source, unavailable device checks, or blocked publication.
- No implied source commits, merges, tag moves, asset replacements, or software installation.

# Entrypoint

## Stage 1: Resolve the requested build

1. Bind `checkout` to the verified task checkout, not its worktree container. The personal anchor
   is `$HOME/docs/src/t3code/main`; a task worktree takes precedence. Read its repository guidance
   and mobile build documentation. Inspect its branch, remotes, status, and requested fix.
2. Distinguish a fresh build from a request for an already published APK. Query GitHub releases
   with `gh release list` and `gh release view --json url,body,assets,targetCommitish`. If the
   existing artifact is verified to include the requested source, proceed to Stage 6. Otherwise,
   proceed to Stage 2. A release timestamp or an old local APK is not proof that a fix is included.
3. The established fork is `Quinntyx/t3code` on GitHub. Its existing mobile release tag is
   `t3code-mobile-v2.1.0-chatgpt-nav`. Verify these before reuse; do not silently select upstream.

## Stage 2: Resolve the local toolchain

1. Prefer the already installed toolchain. A missing `java` on `PATH` does not mean it is absent.
   The established location is `$HOME/android-build-tools`, containing `jdk-*`, `android-sdk`,
   and `gradle-home`. Honor explicit `JAVA_HOME`, `ANDROID_HOME`, and `GRADLE_USER_HOME` overrides.
2. The helper `bin/build-apk` resolves this layout and puts the JDK's `bin` on `PATH`. Both Gradle
   and `apksigner` need that path; setting `JAVA_HOME` alone is insufficient for `apksigner`.
3. Use the existing JDK 21 and SDK build-tools 36.0.0 unless the checkout requires another version.
   `T3_APK_BUILD_TOOLS` selects another installed SDK build-tools version. If prerequisites exist,
   proceed to Stage 3. Otherwise stop and report the missing prerequisite with a user-run install
   command. Do not install tools, switch to EAS, or trigger upstream's Play-mirroring workflow.

## Stage 3: Prepare and verify source

1. Complete the repository's changed-file verification ladder before distribution. Preserve
   unrelated edits. A successful APK build does not substitute for focused tests and checks.
2. Bind `output` to an artifact directory outside the checkout. Keep logs, APKs, and provenance
   out of tracked source. Prevent concurrent source edits while building.
3. Determine whether native prebuild is required. Reuse the generated Android project for JS-only
   changes when its native inputs match and Expo OTA updates are disabled. If native inputs changed,
   the Android project is absent, or OTA remains enabled, add `--prebuild` to the helper invocation
   in Stage 4. Otherwise omit it and proceed to Stage 4. Prebuild can clear generated Android files
   and force expensive native recompilation; do not run it reflexively for every JS change.
4. Prebuild and bundling must both use `APP_VARIANT=preview`. This selects the Preview application
   identity, not a Gradle flavor. The task is `:app:assembleRelease`, not `assemblePreviewRelease`.
5. Keep `T3CODE_MOBILE_UPDATES_ENABLED=0` during prebuild and bundling for this private fork binary.
   Otherwise the upstream Expo update service can replace the fork's embedded JS after launch.
   Supply any checkout-specific public Connect/FCM configuration through its documented environment;
   do not copy service-account keys, signing passwords, or server credentials into the artifact.

## Stage 4: Build the APK

1. Run `bin/build-apk "$checkout" "$output"`, with `--prebuild` only when Stage 3 requires it.
   Resolve the helper relative to this skill directory. It exports the Preview environment, uses
   the cached Gradle home, runs `:app:assembleRelease`, and retains build output under `output`.
2. Run the helper in a dedicated detached tmux window with retained stdout/stderr and an exit file.
   Wait on completion with bounded waits. Keep working while a long native build runs; never
   abandon it and return the old APK. Do not start competing Gradle builds in the same checkout.
3. The helper defaults to offline dependency resolution and four workers. `T3_APK_OFFLINE=0`
   permits dependency fetching when needed; this is not permission to install a missing SDK/JDK.
   `T3_APK_MAX_WORKERS` controls parallelism. Preserve successful native caches and avoid `clean`.
4. Keep the real command exit code. Do not pipe builds through `tail` and then report the filter's
   status as Gradle success. The helper uses `set -euo pipefail` and logs Gradle through `tee`.
5. On a successful exit proceed to Stage 5. On failure, inspect the retained log, repair only the
   diagnosed cause within the requested scope, and return to Stage 4. Do not publish a stale APK.

## Stage 5: Verify the built artifact

1. Read the helper's `t3code-preview.apk.build-info.json`, signature report, checksum, and metadata.
   Require package `com.t3tools.t3code.preview`, a Release build with embedded JS, and a valid APK
   signature. Confirm generated OTA metadata is disabled. Preserve the expected signing identity.
2. The original downloadable Preview APK used the repository debug signing key. Its verified
   certificate SHA-256 is `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`.
   Set `T3_APK_EXPECTED_CERT_SHA256` to this value when updating that installation. A different
   certificate cannot update the installed app. Never advise uninstalling and losing data silently.
3. Inspect the generated release source map for changed runtime modules when available. Compare
   `sourcesContent` with the checkout and embedded JS with Gradle's generated bundle.
   Do not claim fixed source was bundled based solely on APK modification time or a successful task.
4. Read package/version data from `android/app/build/outputs/apk/release/output-metadata.json`.
   Keep the universal APK unless the request calls for a particular ABI. The established artifact
   is a sideloaded release signed with a debug key, not an official store-signed release.
5. Perform available device checks without pretending that signature or source-map checks prove UI
   behavior. If device control is unavailable, report that separately. After verification proceed
   to Stage 6 when publication is requested; otherwise return the local artifact and checks.

## Stage 6: Publish and return the direct link

1. Verify the requested release exists and the authenticated GitHub account can upload to the fork.
   A download-link request authorizes distributing the requested artifact, not merging source,
   force-moving tags, or replacing earlier assets. Use a unique, descriptive `.apk` asset name.
2. If source is uncommitted, disclose that in the release asset label or release notes and preserve
   the base commit and tracked-diff SHA-256 in provenance. Do not imply that the release tag
   contains those edits. Publishing or moving source references requires separate authorization.
3. Copy the verified APK to the chosen asset basename, then run
   `gh release upload "$tag" "$asset" --repo "$repository"` in a detached tmux job when needed.
   Retain its real exit status. Do not use `--clobber` unless asset replacement was authorized.
4. Query `gh release view "$tag" --repo "$repository" --json assets,url` after upload. Select the
   exact asset name, require state `uploaded`, and compare its size and GitHub SHA-256 digest with
   the local file. If verification succeeds, return that asset's URL. Otherwise stop and report the
   publication failure without presenting an older artifact as the new build.
5. Prefer the API's exact `assets[].url` value over a guessed URL, an Actions artifact requiring
   authentication, or an Expo dev-client link. Return a concise clickable APK link and only the
   relevant install or verification caveats.

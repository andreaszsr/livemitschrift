# Releasing

LiveMitschrift is licensed under **AGPL-3.0-only**. The unmodified license text is
in `LICENSE`, and every package uses the same SPDX identifier. The Docker image
and the macOS bundle both include the license file.

## Repository settings

- Enable private vulnerability reporting, Dependabot alerts and Actions.
- Protect `main` and require CI to pass.
- Create an environment named `release`:
  - require reviewers;
  - restrict it to version tags;
  - protect release tags against replacement and deletion.
- After the first image is published, make the GHCR package public so it can be
  pulled anonymously.
- The workflows pin each action to a commit and use only the scoped automatic
  `GITHUB_TOKEN`. CI needs no personal token and no publisher key.

## Release checklist

1. All CI jobs pass on the release commit:
   - tests;
   - dependency audits;
   - secret scan;
   - container vulnerability gate;
   - 50-reader HTTPS installation test.
2. Versions match the tag. See [Workflows](#workflows).
3. Run the [isolated native checks](testing.md#isolated-native-checks-macos) and
   a short [manual pen check](testing.md#pen-input-wacom-or-another-tablet) on
   the final binary.
4. Tag `vX.Y.Z`. Review the draft GitHub Release, verify the signature and
   notarization of the download, and then publish the release.
5. Update a test server to the new image and check reading, publishing and
   backup.

## Workflows

`ci.yml` runs JavaScript/Python/Rust tests, runtime dependency audits, source/history
secret checks, a container vulnerability gate and a disposable 50-reader HTTPS
installation test. `release.yml` reuses CI only after version/license preflight.

A `vX.Y.Z` tag must match versions in root `package.json`, backend
`pyproject.toml`, desktop `Cargo.toml` and `tauri.conf.json` (keep workspace versions
and package/Cargo locks consistent as well). Tagging a reviewed release commit starts two protected-environment jobs:

- GHCR `ghcr.io/<owner>/<repository>:X.Y.Z`, lowercase package path, Linux AMD64
  and ARM64, with SBOM and build provenance. There is no floating `latest` tag.
- Apple Silicon macOS `.app`/`.dmg`, attached to a **draft** GitHub Release. Review
  the draft and verify the downloaded signature/notarization before publishing it.
  The container job publishes independently after the environment approval; a Mac
  signing failure does not roll back an already published image.

Use immutable image digests for deployments that must not follow moved tags.
See [GitHub's image publishing guide](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).

## Apple credentials

Provide these environment secrets for `release` only:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application certificate/private key `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full Developer ID Application signing identity |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_PRIVATE_KEY` | Contents of that key's `.p8` |

`prepare_macos_release.py` imports signing material into a temporary runner
keychain and writes a temporary Tauri signing override. Cleanup runs even after a
failed build. Do not add these files to the repository or provide them to pull
request jobs. The normal local ad-hoc configuration remains suitable for local
testing. See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/).

The first target is Apple Silicon macOS 13+. There is no automatic app updater.
A public signed and notarized build needs real Apple Developer credentials.

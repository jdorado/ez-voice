# Releasing

Use the same contribution, review and release process as the other Ez packages. Version package and
plugin manifests together. Initial beta is 0.1.0-beta.1, npm package @jc_stack/ez-voice, repository
jdorado/ez-voice. Never overwrite a version or tag.

1. Run frozen install, verify, release:check, diff check and dependency audit. Copy the root pnpm lock
   to docker/pnpm-lock.yaml after dependency changes; npm omits the root lock.
2. Pack with `npm pack --ignore-scripts`, inspect the allowlist and hash the exact bytes. Extract into
   a clean directory. Build test/runtime images there and run `docker/smoke.mjs` with that runtime image.
3. Verify install/start/doctor/CLI dispatch/restart/uninstall through the actual Ez manager using
   separate synthetic state, then install the same candidate on the authorized local agent for voice QA.
4. Obtain independent final-diff review and required CI. Merge under the maintainer's release request,
   verify the merged tree, and tag that commit. Keep all customer data and private QA out of Git history.
5. Initial npm publication requires authenticated npm as jc_stack and applicable 2FA. Publish the exact
   tested tarball with `npm publish PATH --access public --tag latest`. There is no token/2FA workaround.
   Read back registry metadata, download the published tarball and compare SHA-256; publish a GitHub
   prerelease containing those exact bytes and a sanitized verification record.
6. Enroll npm trusted publishing for the repository's reviewed publish-beta.yml after the package
   exists. Reuse the core shared publisher and its exact-artifact contract; do not copy publisher logic.
7. Report source, artifact, published version and local installed state separately. Human microphone
   and audible-quality acceptance remains required before claiming end-to-end voice QA complete.

The bundled authenticated client is packaged for reproducible QA; public HTTPS
ingress remains an operator-owned deployment and is not created by this package.
Close retained QA worktrees after acceptance; retain only when a named pending gate needs them.

# Contributing

Read README.md, SECURITY.md and docs/releasing.md. Humans and agents use the same process.
Use a dedicated worktree and branch from freshly fetched origin/main, preserve unrelated work,
and open one coherent PR. Keep local QA, credentials and customer records outside the repository.

Run `pnpm install --frozen-lockfile`, `pnpm verify`, `npm run release:check` and `git diff --check`.
For runtime or packaging changes also build the Docker test and runtime targets from the packed
artifact and run `docker/smoke.mjs`. Obtain independent final-diff review and required CI before
merge. Record review identity, commit and resolved findings in the PR. Maintainer requests authorize
normal implementation and requested shipping; merge alone never means publication.

Authority, input validation, cancellation, secrets and uncertain external operations require negative
tests. Use synthetic data for routine tests. Real microphone/provider QA needs an authorized owner
and account. Keep one writer per shared workspace. Do not add a second engine, shell tool or automatic
plugin discovery-to-permission pipeline to recover a failed operation.

After merge, preserve any unique work/evidence, then remove clean task worktrees and branches.
Report installed version and actual user-path evidence separately from CI and publication.

# Contributing

Thank you for contributing to homebridge-ttlock-accesscode!

## Forked PRs and Workflow Limitations

> **Note:** If you open a PR or issue in your own fork, GitHub Actions **will not have access to repository secrets** and privileged automation (labeling, validation, sticky comments) will be **skipped**.
> Once you open a PR or issue against the main repository (`ZeliardM/homebridge-ttlock-accesscode`), all workflows and automation will run as expected.

- If you see notices about "skipped steps due to fork context" or missing secrets, this is expected.
- Validation, labeling, and sticky comments will be applied after your PR/issue is opened against the main repository.

## Branch Model
- latest: Stable release branch.
- beta: Active development toward next release.
- Feature branches: Create from beta (not latest) and open PRs targeting beta.

## Pull Requests
1. Install Node deps: `npm ci`
2. Lint: `npm run lint` (must pass).
3. Build: `npm run build`
4. Sanity imports:
   ```bash
   node -e "import('./dist/index.js').then(()=>console.log('Node OK'))"
   ```
5. Name the branch for the change, so the PR gets the right labels (see Labels).
6. One logical change per PR.

## Release Flow (Simplified)
- Merge PR into beta -> CHANGELOG updated & draft/update of current beta automatically.
- Unpublished beta.0 aggregates subsequent PRs (single tag).
- After publishing a beta, new changes create beta.(N+1) drafts.
- Breaking change after publish escalates to new major base beta.0 when allowed.
- Manual conversion (workflow_dispatch) consolidates published betas into a stable draft.
- Publishing stable adds finalization entry.

## Changelog & Bodies
- vX.Y.Z-beta.N
  ```

  ## Category
  - entry

  **Full Changelog**: compare/<from>...<to>
  ```
- Stable body omits “-beta.N”.

## Labels
Labels pick the CHANGELOG section and the version bump. When a PR is opened and on every push to it, the PR workflow clears its labels and sets them again from the branch name and the changed files, so labels added by hand do not last:
- `feat/...` or `feature/...` -> enhancement (minor version)
- `fix/...` or `hotfix/...` -> fix (patch)
- `bug/...` -> bug (patch)
- a branch name containing `breaking` -> breaking-change (major); the PR body then needs the breaking change explanation from the PR template.
- Changed files add docs (`*.md`), dependency (`package.json`, `package-lock.json`) and workflow (`.github/`).

A PR needs at least one of these labels to pass validation. Changing `src/` alone adds no label, so use a branch prefix.

## Security / Quality
- CodeQL runs on PRs.
- Dependabot weekly updates target beta.

## Questions
Open a support request issue or discussion.

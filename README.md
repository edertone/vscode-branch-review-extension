# Branch Review

VS Code extension that downloads two git branches into `.branchReview/` at the root of the repository, so they can be compared side by side.

## Usage

1. Run **Branch Review: Open Panel** from the Command Palette.
2. The first input defaults to the current branch of the active repository; the second defaults to `develop`. Change either one as needed.
3. Click **Download**.

Each branch is written to its own folder:

```
.branchReview/
  <first-branch>/
  <second-branch>/
```

Characters other than letters, digits, `.`, `_` and `-` in a branch name are replaced with `_` in the folder name (e.g. `feature/x` → `feature_x`).

Clicking **Download** again replaces the folders with the latest data.

Click **Clear .branchReview** to delete the whole `.branchReview/` folder. A confirmation dialog is shown first.

## How it works

- Fetches each branch from `origin` (`+refs/heads/<branch>`). If the fetch fails, or there is no `origin`, the local branch is used.
- Exports the committed tree of the branch. Your index, `HEAD`, and working tree are not modified; uncommitted changes are not included.
- Logs are written to the **Branch Review** output channel.

## Development

```bash
npm install
npm run compile
npm run package   # produces branch-review-<version>.vsix
```

Install the `.vsix` with **Extensions: Install from VSIX...** in VS Code.

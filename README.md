# Branch Review

VS Code extension that downloads a baseline and target Git branch into `.branchReview/` at the root of the repository, and creates a compact review bundle for AI-assisted analysis.

## Usage

1. Run **Branch Review: Open View** from the Command Palette to open Branch Review in VS Code's Secondary Side Bar, alongside Chat.
2. The panel shows the saved review when `.branchReview/` contains a valid download. Otherwise, or when you choose **Choose branches / Download**, a modal opens for selecting the **Baseline branch (old)** and **Target branch (new)**. Baseline defaults to `develop` and target to the current branch when available.
3. Click **Download** in the modal. The view then displays the saved branch revisions and changed-file list.

VS Code 1.106 or later is required. If you have moved the view, VS Code will reopen it in its saved location; use **View: Reset View Locations** to restore its default position.

Use **Browse branches** under either input to see the full list of local branches and branches queried directly from every configured remote, including branches not yet fetched. You can also type a branch name. Remote branches are shown as `remote/branch` (for example, `origin/develop`); an unqualified name uses `origin`. If a remote cannot be queried, a warning is shown and its cached remote-tracking branches are not listed.

Click **Refresh branches** in the modal to query origin and the other configured remotes again without changing the selected or typed branch names. The view follows the active editor's Git repository; if no editor belongs to a repository when opened, it uses the first open repository. The displayed project name is the repository's folder name. The extension watches the selected repository's `.branchReview/` folder and updates the view when its contents change.

The selected branches are written to role-based folders, regardless of their branch names:

```
.branchReview/
  baseline/
  target/
  ai-review/
```

`ai-review/` contains:

- `manifest.json`: exact branch names, commit IDs, commit times, generation details, and size limits.
- `overview.md`: comparison direction and review guidance.
- `changed-files.json`: changed paths and links to per-file diffs.
- `files/`: unified diffs with 40 lines of context.
- `commits.json`: commits reachable from target but not baseline.
- `context/`: selected small project README and manifest files from target.

The comparison is a direct tree diff from baseline to target; it does not infer age from branch names or commit dates and is not a merge-base comparison. Large diffs and commit lists are capped, with truncation recorded in the bundle. Each download builds the complete review in a staging folder and replaces `.branchReview/` only after all branch snapshots and review data have been generated. This removes stale files and preserves the previous valid folder if building the replacement fails. The extension treats the folder as the source of truth; if its required files are missing or invalid, the branch-selection modal opens automatically. The AI bundle is generated locally; the extension does not send repository contents to an AI service.

Click **Clear .branchReview** to delete the whole `.branchReview/` folder. A confirmation dialog is shown first.

## How it works

- Fetches each branch from its specified remote, or from `origin` for unqualified names. If a fetch fails or the required remote is not configured, you can cancel or explicitly choose a locally available commit that may be out of date. The cached remote-tracking branch is preferred; for unqualified names, a local branch is used if no cached remote branch exists. If no local commit is available, the download fails. Cancelling or failing preserves the existing review.
- Exports the committed tree of the branch. Your index, `HEAD`, and working tree are not modified; uncommitted changes are not included.
- Generates `ai-review/` only after both branch trees have been exported successfully.
- Logs are written to the **Branch Review** output channel.

## Development

```bash
npm run build   # installs dependencies, compiles, and produces branch-review-<version>.vsix
```

Install the `.vsix` with **Extensions: Install from VSIX...** in VS Code.

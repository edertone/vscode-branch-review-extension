import * as vscode from "vscode";
import * as path from "path";
import {
  BRANCH_REVIEW_DIR,
  clearBranchReview,
  getCurrentBranchName,
  listBranches,
  readBranchReview,
  rebuildBranchReview,
} from "./git";

const DEFAULT_BASELINE_BRANCH = "develop";
const VIEW_ID = "branchReview.view";

interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: { name?: string } };
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository(listener: (repository: GitRepository) => void): vscode.Disposable;
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

type WebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "download"; baseline: string; target: string }
  | { type: "clear" };

let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Branch Review");
  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      { resolveWebviewView: (view) => resolveView(context, view) },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("branchReview.open", () => openView()),
  );
}

async function openView(): Promise<void> {
  const repo = await findRepository(
    vscode.window.activeTextEditor?.document.uri.fsPath,
  );
  if (!repo) {
    vscode.window.showErrorMessage(
      "Branch Review: no git repository found in the workspace.",
    );
    return;
  }
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
}

async function getGitApi(): Promise<GitApi | undefined> {
  const gitExtension =
    vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!gitExtension) {
    return undefined;
  }
  const exports = gitExtension.isActive
    ? gitExtension.exports
    : await gitExtension.activate();
  return exports.getAPI(1);
}

/** Picks the repository of the active editor, falling back to the first open repository. */
async function findRepository(
  activeFile?: string,
  fallback = true,
): Promise<GitRepository | undefined> {
  const api = await getGitApi();
  const repos = api?.repositories ?? [];
  if (repos.length === 0) {
    return undefined;
  }
  if (activeFile) {
    const match = repos
      .filter(
        (r) =>
          activeFile === r.rootUri.fsPath ||
          activeFile.startsWith(r.rootUri.fsPath + path.sep),
      )
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (match) {
      return match;
    }
  }
  return fallback ? repos[0] : undefined;
}

function resolveView(
  context: vscode.ExtensionContext,
  currentView: vscode.WebviewView,
): void {
  const webview = currentView.webview;
  webview.options = { enableScripts: true };
  let currentRepo: GitRepository | undefined;
  let revision = 0;
  let editorRevision = 0;
  let busy = false;
  let pendingRepo: GitRepository | undefined;
  let ready = false;
  let disposed = false;
  let folderWatcher: vscode.FileSystemWatcher | undefined;
  let folderChangeTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshFolderAfterAction = false;
  const viewSubscriptions: vscode.Disposable[] = [];

  const disposeView = () => {
    if (disposed) return;
    disposed = true;
    folderWatcher?.dispose();
    if (folderChangeTimer) clearTimeout(folderChangeTimer);
    for (const subscription of viewSubscriptions) {
      subscription.dispose();
    }
  };
  context.subscriptions.push({ dispose: disposeView });
  viewSubscriptions.push(currentView.onDidDispose(disposeView));

  const syncReviewState = () => {
    if (!currentRepo) return;
    if (busy) {
      refreshFolderAfterAction = true;
      return;
    }
    const selectedRepo = currentRepo;
    const selectedRevision = revision;
    void readBranchReview(selectedRepo.rootUri.fsPath).then(
      (review) => {
        if (!disposed && selectedRevision === revision) {
          void webview.postMessage({ type: "reviewState", review });
        }
      },
      (err: Error) => {
        output?.appendLine(`Error reading .branchReview: ${err.message}`);
        vscode.window.showErrorMessage(
          `Branch Review: unable to read .branchReview: ${err.message}`,
        );
      },
    );
  };
  const watchRepository = (selectedRepo: GitRepository) => {
    folderWatcher?.dispose();
    folderWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        selectedRepo.rootUri,
        `${BRANCH_REVIEW_DIR}/**`,
      ),
    );
    const onFolderChange = () => {
      if (folderChangeTimer) clearTimeout(folderChangeTimer);
      folderChangeTimer = setTimeout(() => {
        folderChangeTimer = undefined;
        syncReviewState();
      }, 100);
    };
    folderWatcher.onDidCreate(onFolderChange);
    folderWatcher.onDidChange(onFolderChange);
    folderWatcher.onDidDelete(onFolderChange);
  };

  const loadRepository = () => {
    if (!currentRepo) return;
    const selectedRepo = currentRepo;
    const selectedRevision = ++revision;
    watchRepository(selectedRepo);
    void webview.postMessage({
      type: "project",
      name: path.basename(selectedRepo.rootUri.fsPath),
      repoRoot: selectedRepo.rootUri.fsPath,
    });
    void initializePanel(
      webview,
      selectedRepo,
      () => !disposed && selectedRevision === revision,
    );
  };
  const selectRepository = (selectedRepo: GitRepository) => {
    if (busy) {
      pendingRepo = selectedRepo;
    } else if (selectedRepo.rootUri.fsPath !== currentRepo?.rootUri.fsPath) {
      currentRepo = selectedRepo;
      if (ready) loadRepository();
    }
  };
  const editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    const selectedRevision = ++editorRevision;
    void findRepository(editor.document.uri.fsPath, false).then(
      (selectedRepo) => {
        if (!disposed && selectedRevision === editorRevision && selectedRepo) {
          selectRepository(selectedRepo);
        }
      },
      (err: Error) => {
        output?.appendLine(`Error selecting repository: ${err.message}`);
        vscode.window.showErrorMessage(
          `Branch Review: unable to select repository: ${err.message}`,
        );
      },
    );
  });
  viewSubscriptions.push(editorListener);
  void getGitApi().then(
    (api) => {
      if (disposed || !api) return;
      viewSubscriptions.push(
        api.onDidOpenRepository((repository) => {
          const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
          if (currentRepo &&
              (!activeFile ||
                (activeFile !== repository.rootUri.fsPath &&
                  !activeFile.startsWith(repository.rootUri.fsPath + path.sep)))) {
            return;
          }
          const selectedEditorRevision = ++editorRevision;
          void findRepository(activeFile).then(
            (selectedRepo) => {
              if (!disposed && selectedEditorRevision === editorRevision && selectedRepo) {
                selectRepository(selectedRepo);
              }
            },
            (err: Error) => {
              output?.appendLine(`Error selecting repository: ${err.message}`);
              vscode.window.showErrorMessage(
                `Branch Review: unable to select repository: ${err.message}`,
              );
            },
          );
        }),
      );
    },
    (err: Error) => {
      output?.appendLine(`Error watching Git repositories: ${err.message}`);
      vscode.window.showErrorMessage(
        `Branch Review: unable to watch Git repositories: ${err.message}`,
      );
    },
  );

  viewSubscriptions.push(
    currentView.onDidChangeVisibility(() => {
      if (currentView.visible) {
        syncReviewState();
      }
    }),
  );

  viewSubscriptions.push(
    webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === "ready") {
        ready = true;
        const selectedEditorRevision = ++editorRevision;
        void findRepository(
          vscode.window.activeTextEditor?.document.uri.fsPath,
        ).then(
          (selectedRepo) => {
            if (disposed || selectedEditorRevision !== editorRevision) return;
            if (selectedRepo) {
              currentRepo = selectedRepo;
              loadRepository();
            } else if (!currentRepo) {
              const text =
                "Branch Review: no git repository found in the workspace.";
              vscode.window.showErrorMessage(text);
              void webview.postMessage({
                type: "initError",
                text,
                review: { valid: false, reason: text },
              });
            }
          },
          (err: Error) => {
            output?.appendLine(`Error selecting repository: ${err.message}`);
            vscode.window.showErrorMessage(
              `Branch Review: unable to select repository: ${err.message}`,
            );
          },
        );
      } else if (!busy) {
        if (!currentRepo) {
          void webview.postMessage({
            type: "error",
            text: "No Git repository is available for Branch Review.",
          });
          return;
        }
        busy = true;
        const repoRoot = currentRepo.rootUri.fsPath;
        const action =
          message.type === "refresh"
            ? refreshBranches(webview, repoRoot)
            : message.type === "clear"
              ? handleClear(webview, repoRoot)
              : handleDownload(webview, message, repoRoot);
        void action.finally(() => {
          busy = false;
          if (pendingRepo) {
            const selectedRepo = pendingRepo;
            pendingRepo = undefined;
            selectRepository(selectedRepo);
          } else if (refreshFolderAfterAction) {
            refreshFolderAfterAction = false;
            syncReviewState();
          }
        });
      }
    }),
  );
  webview.html = getHtml(webview);
}

async function initializePanel(
  webview: vscode.Webview,
  repo: GitRepository,
  isCurrent: () => boolean,
): Promise<void> {
  try {
    const repoRoot = repo.rootUri.fsPath;
    const currentBranch =
      (await getCurrentBranchName(repoRoot)) ?? repo.state.HEAD?.name ?? "";
    const [{ branches, warnings }, review] = await Promise.all([
      listBranches(repoRoot),
      readBranchReview(repoRoot),
    ]);
    if (!isCurrent()) return;
    for (const warning of warnings) {
      output?.appendLine(`Warning: ${warning}`);
    }
    await webview.postMessage({
      type: "init",
      baseline: DEFAULT_BASELINE_BRANCH,
      target: currentBranch,
      branches,
      warnings,
      repoRoot,
      review,
    });
  } catch (err) {
    if (!isCurrent()) return;
    const text = `Unable to list repository branches: ${(err as Error).message}`;
    output?.appendLine(`Error: ${text}`);
    const review = await readBranchReview(repo.rootUri.fsPath);
    webview.postMessage({ type: "initError", text, review });
  }
}

async function refreshBranches(
  webview: vscode.Webview,
  repoRoot: string,
): Promise<void> {
  webview.postMessage({ type: "refreshing", refreshing: true });
  try {
    const { branches, warnings } = await listBranches(repoRoot);
    for (const warning of warnings) {
      output?.appendLine(`Warning: ${warning}`);
    }
    await webview.postMessage({ type: "refreshed", branches, warnings });
  } catch (err) {
    const text = `Unable to refresh repository branches: ${(err as Error).message}`;
    output?.appendLine(`Error: ${text}`);
    webview.postMessage({ type: "error", text });
  } finally {
    webview.postMessage({ type: "refreshing", refreshing: false });
  }
}

async function handleClear(
  webview: vscode.Webview,
  repoRoot: string,
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "Delete the .branchReview folder and all downloaded branches?",
    { modal: true },
    "Delete",
  );
  if (confirm !== "Delete") {
    return;
  }

  webview.postMessage({ type: "busy", busy: true });
  try {
    const removed = await clearBranchReview(repoRoot);
    const text = removed
      ? "Deleted .branchReview."
      : "Nothing to delete: .branchReview does not exist.";
    output?.appendLine(text);
    webview.postMessage({ type: "done", text });
    const review = await readBranchReview(repoRoot);
    webview.postMessage({ type: "reviewState", review });
  } catch (err) {
    const text = (err as Error).message;
    output?.appendLine(`Error: ${text}`);
    webview.postMessage({ type: "error", text });
  } finally {
    webview.postMessage({ type: "busy", busy: false });
  }
}

async function handleDownload(
  webview: vscode.Webview,
  message: WebviewMessage,
  repoRoot: string,
): Promise<void> {
  if (message.type !== "download") {
    return;
  }
  const branches = [message.baseline.trim(), message.target.trim()];

  if (branches.some((b) => !b)) {
    webview.postMessage({
      type: "error",
      text: "Both baseline and target branch names are required.",
    });
    return;
  }
  if (branches[0] === branches[1]) {
    webview.postMessage({
      type: "error",
      text: "Please choose different baseline and target branches.",
    });
    return;
  }

  const log = (text: string) => {
    output?.appendLine(text);
    webview.postMessage({ type: "progress", text });
  };

  webview.postMessage({ type: "busy", busy: true });
  try {
    log(`Downloading baseline "${branches[0]}"`);
    log(`Downloading baseline "${branches[0]}"`);
    const review = await rebuildBranchReview(
      repoRoot,
      branches[0],
      branches[1],
      log,
    );
    const summary = `Downloaded baseline "${review.baseline.branch}" and target "${review.target.branch}" to ${path.join(repoRoot, BRANCH_REVIEW_DIR)}`;
    output?.appendLine(summary);
    webview.postMessage({ type: "reviewState", review });
    webview.postMessage({ type: "done", text: summary });
    vscode.window.showInformationMessage(`Branch Review: ${summary}`);
  } catch (err) {
    const text = (err as Error).message;
    output?.appendLine(`Error: ${text}`);
    webview.postMessage({ type: "error", text });
  } finally {
    webview.postMessage({ type: "busy", busy: false });
  }
}

function getHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Branch Review</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    h2 { font-weight: 600; margin-top: 0; }
    h3 { margin: 0 0 8px; }
    label { display: block; margin-top: 12px; margin-bottom: 4px; }
    input, select {
      box-sizing: border-box; width: 100%; padding: 6px 8px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); outline: none;
    }
    input:focus, select:focus { border-color: var(--vscode-focusBorder); }
    select { margin-top: 4px; }
    .branch-row { display: flex; gap: 8px; }
    .branch-row input { flex: 1; min-width: 0; }
    .branch-row select { flex: 0 0 42%; min-width: 0; margin-top: 0; }
    button {
      margin-top: 12px; padding: 6px 14px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none;
    }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.6; cursor: default; }
    .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); margin-left: 8px; }
    .secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    #project { overflow-wrap: anywhere; }
    #savedReview { margin-top: 20px; max-width: 760px; }
    #reviewDetails { white-space: pre-wrap; }
    #changedFiles { max-height: 45vh; overflow: auto; padding-left: 20px; overflow-wrap: anywhere; }
    #status { margin-top: 16px; white-space: pre-wrap; font-size: 12px; }
    .error { color: var(--vscode-errorForeground); }
    .muted { color: var(--vscode-descriptionForeground); }
    .modal { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 20px; background: var(--vscode-editor-background); }
    .modal[hidden], [hidden] { display: none !important; }
    .modal-content { width: min(520px, 100%); max-height: 90vh; overflow: auto; padding: 20px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border); box-shadow: 0 8px 32px #0006; }
    .modal-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; }
    .modal-actions .secondary { margin-left: 0; }
    .modal-actions-end { display: flex; align-items: center; gap: 8px; }
  </style>
</head>
<body>
  <h2>Branch Review</h2>
  <div id="project" class="muted">Loading project...</div>
  <section id="savedReview" hidden>
    <h3>Downloaded review data</h3>
    <div id="reviewDetails"></div>
    <ul id="changedFiles"></ul>
  </section>
  <div id="noReview" class="muted">Checking .branchReview...</div>
  <button id="chooseBranches" type="button" disabled>Choose branches / Download</button>
  <button id="clear" class="secondary" type="button" disabled>Clear .branchReview</button>
  <div id="status" class="muted">Loading branches...</div>

  <div id="selectionModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" hidden>
    <div class="modal-content">
      <h3 id="modalTitle">Choose branches</h3>
      <p id="modalHelp" class="muted">Select or type the branches to compare. Download rebuilds the entire .branchReview folder.</p>
      <form id="form">
        <label for="baseline">Baseline branch (old code)</label>
        <div class="branch-row">
          <input id="baseline" autocomplete="off" placeholder="Type or select a branch">
          <select id="baselineBranches" aria-label="Select baseline branch" disabled></select>
        </div>
        <label for="target">Target branch (new code to review)</label>
        <div class="branch-row">
          <input id="target" autocomplete="off" placeholder="Type or select a branch">
          <select id="targetBranches" aria-label="Select target branch" disabled></select>
        </div>
        <div class="modal-actions">
          <button id="refresh" class="secondary" type="button" disabled>Refresh branches</button>
          <div class="modal-actions-end">
            <button id="cancel" class="secondary" type="button" hidden>Cancel</button>
            <button id="download" type="submit" disabled>Download</button>
          </div>
        </div>
      </form>
      <div id="modalStatus" class="muted" aria-live="polite"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const baseline = document.getElementById('baseline');
    const target = document.getElementById('target');
    const button = document.getElementById('download');
    const clearButton = document.getElementById('clear');
    const refreshButton = document.getElementById('refresh');
    const chooseButton = document.getElementById('chooseBranches');
    const cancelButton = document.getElementById('cancel');
    const project = document.getElementById('project');
    const savedReview = document.getElementById('savedReview');
    const reviewDetails = document.getElementById('reviewDetails');
    const changedFiles = document.getElementById('changedFiles');
    const noReview = document.getElementById('noReview');
    const selectionModal = document.getElementById('selectionModal');
    const modalTitle = document.getElementById('modalTitle');
    const baselineBranches = document.getElementById('baselineBranches');
    const targetBranches = document.getElementById('targetBranches');
    const status = document.getElementById('status');
    const modalStatus = document.getElementById('modalStatus');
    let isBusy = false;
    let isLoading = true;
    let isRefreshing = false;
    let baselineEdited = false;
    let targetEdited = false;
    let hasValidReview = false;

    function setStatus(text, isError) {
      status.className = isError ? 'error' : 'muted';
      status.textContent = text;
      modalStatus.className = isError ? 'error' : 'muted';
      modalStatus.textContent = text;
    }

    function showPicker(required) {
      selectionModal.hidden = false;
      cancelButton.hidden = required;
      if (required) {
        baseline.focus();
      }
    }

    function renderReview(review) {
      hasValidReview = review && review.valid === true;
      if (!hasValidReview) {
        savedReview.hidden = true;
        noReview.hidden = false;
        noReview.textContent = review && review.reason
          ? 'No valid downloaded review: ' + review.reason
          : 'No valid downloaded review. Choose branches to create one.';
        showPicker(true);
        return;
      }
      savedReview.hidden = false;
      noReview.hidden = true;
      reviewDetails.textContent =
        'Baseline: ' + review.baseline.branch + ' (' + review.baseline.commit.slice(0, 8) + ')\\n' +
        'Target: ' + review.target.branch + ' (' + review.target.commit.slice(0, 8) + ')\\n' +
        'Generated: ' + review.generatedAt + '\\n' +
        'Changed files: ' + review.summary.changedFiles +
        (review.summary.shortStat ? ' — ' + review.summary.shortStat : '');
      changedFiles.replaceChildren();
      for (const file of review.files) {
        const item = document.createElement('li');
        item.textContent = file.status + '  ' + file.path;
        changedFiles.appendChild(item);
      }
      selectionModal.hidden = true;
    }

    function updateDownloadState() {
      const base = baseline.value.trim();
      const head = target.value.trim();
      button.disabled = isBusy || isLoading || isRefreshing || !base || !head || base === head;
      refreshButton.disabled = isBusy || isLoading || isRefreshing;
      clearButton.disabled = isBusy || isLoading || isRefreshing;
      chooseButton.disabled = isBusy || isLoading || isRefreshing;
      baselineBranches.disabled = isBusy || isLoading || isRefreshing;
      targetBranches.disabled = isBusy || isLoading || isRefreshing;
      baseline.disabled = isBusy || isLoading || isRefreshing;
      target.disabled = isBusy || isLoading || isRefreshing;
    }

    function populateBranches(branches) {
      for (const list of [baselineBranches, targetBranches]) {
        list.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Browse branches...';
        list.appendChild(placeholder);
        for (const branch of branches) {
          const option = document.createElement('option');
          option.value = branch;
          option.textContent = branch;
          list.appendChild(option);
        }
        list.value = '';
      }
    }

    baseline.addEventListener('input', () => { baselineEdited = true; updateDownloadState(); });
    target.addEventListener('input', () => { targetEdited = true; updateDownloadState(); });
    baselineBranches.addEventListener('change', () => {
      if (baselineBranches.value) {
        baseline.value = baselineBranches.value;
        baselineEdited = true;
        baselineBranches.value = '';
        updateDownloadState();
      }
    });
    targetBranches.addEventListener('change', () => {
      if (targetBranches.value) {
        target.value = targetBranches.value;
        targetEdited = true;
        targetBranches.value = '';
        updateDownloadState();
      }
    });

    document.getElementById('form').addEventListener('submit', event => {
      event.preventDefault();
      if (button.disabled) {
        return;
      }
      vscode.postMessage({ type: 'download', baseline: baseline.value, target: target.value });
    });

    clearButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    chooseButton.addEventListener('click', () => {
      showPicker(false);
    });

    cancelButton.addEventListener('click', () => {
      if (hasValidReview && !isBusy) {
        selectionModal.hidden = true;
      }
    });

    refreshButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'project':
          project.textContent = 'Project: ' + message.name;
          project.title = message.repoRoot;
          modalTitle.textContent = 'Choose branches — ' + message.name;
          baseline.value = '';
          target.value = '';
          baselineEdited = false;
          targetEdited = false;
          populateBranches([]);
          isLoading = true;
          setStatus('Loading branches...', false);
          updateDownloadState();
          break;
        case 'init':
          const branches = message.branches;
          const preferred = name => branches.includes('origin/' + name) ? 'origin/' + name : name;
          const preferredTarget = preferred(message.target);
          const preferredBaseline = preferred(message.baseline);
          const targetDefault = branches.includes(preferredTarget) ? preferredTarget : (branches[0] || '');
          const baselineDefault = branches.includes(preferredBaseline) && preferredBaseline !== targetDefault
            ? preferredBaseline
            : (branches.find(branch => branch !== targetDefault) || '');
          populateBranches(branches);
          if (!baselineEdited) baseline.value = baselineDefault;
          if (!targetEdited) target.value = targetDefault;
          isLoading = false;
          renderReview(message.review);
          setStatus(message.warnings.join('\\n') ||
            (branches.length ? '' : 'No branches found. You can type branch names.'),
            message.warnings.length > 0);
          updateDownloadState();
          break;
        case 'refreshing':
          isRefreshing = message.refreshing;
          refreshButton.textContent = isRefreshing ? 'Refreshing...' : 'Refresh branches';
          if (isRefreshing) {
            setStatus('Refreshing branches...', false);
          }
          updateDownloadState();
          break;
        case 'refreshed':
          populateBranches(message.branches);
          setStatus(message.warnings.join('\\n') ||
            (message.branches.length ? 'Branches refreshed.' : 'No branches found. You can type branch names.'),
            message.warnings.length > 0);
          updateDownloadState();
          break;
        case 'busy':
          isBusy = message.busy;
          updateDownloadState();
          button.textContent = message.busy ? 'Downloading...' : 'Download';
          break;
        case 'progress':
          setStatus(message.text, false);
          break;
        case 'done':
          setStatus(message.text, false);
          break;
        case 'error':
          setStatus(message.text, true);
          break;
        case 'initError':
          isLoading = false;
          renderReview(message.review);
          setStatus(message.text, true);
          updateDownloadState();
          break;
        case 'reviewState':
          renderReview(message.review);
          updateDownloadState();
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

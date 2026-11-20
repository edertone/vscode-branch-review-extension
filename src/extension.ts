import * as vscode from "vscode";
import * as path from "path";
import {
  clearBranchReview,
  downloadBranch,
  generateAiReviewBundle,
  getCurrentBranchName,
  listBranches,
} from "./git";

const DEFAULT_BASELINE_BRANCH = "develop";

interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: { name?: string } };
}

interface GitApi {
  repositories: GitRepository[];
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

type WebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "download"; baseline: string; target: string }
  | { type: "clear" };

let panel: vscode.WebviewPanel | undefined;
let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Branch Review");
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("branchReview.open", () =>
      openPanel(context),
    ),
  );
}

export function deactivate(): void {
  panel?.dispose();
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
async function findRepository(activeFile?: string, fallback = true): Promise<GitRepository | undefined> {
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

async function openPanel(context: vscode.ExtensionContext): Promise<void> {
  if (panel) {
    panel.reveal();
    return;
  }

  const repo = await findRepository(vscode.window.activeTextEditor?.document.uri.fsPath);
  if (!repo) {
    vscode.window.showErrorMessage(
      "Branch Review: no git repository found in the workspace.",
    );
    return;
  }
  panel = vscode.window.createWebviewPanel(
    "branchReview",
    "Branch Review",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  const currentPanel = panel;
  let currentRepo = repo;
  let revision = 0;
  let editorRevision = 0;
  let busy = false;
  let pendingRepo: GitRepository | undefined;
  let ready = false;
  let disposed = false;

  const loadRepository = () => {
    const selectedRepo = currentRepo;
    const selectedRevision = ++revision;
    void currentPanel.webview.postMessage({
      type: "project",
      name: path.basename(selectedRepo.rootUri.fsPath),
      repoRoot: selectedRepo.rootUri.fsPath,
    });
    void initializePanel(currentPanel.webview, selectedRepo, () =>
      !disposed && selectedRevision === revision,
    );
  };
  const selectRepository = (selectedRepo: GitRepository) => {
    if (busy) {
      pendingRepo = selectedRepo;
    } else if (selectedRepo.rootUri.fsPath !== currentRepo.rootUri.fsPath) {
      currentRepo = selectedRepo;
      if (ready) loadRepository();
    }
  };
  const editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    const selectedRevision = ++editorRevision;
    void findRepository(editor.document.uri.fsPath, false).then((selectedRepo) => {
      if (!disposed && selectedRevision === editorRevision && selectedRepo) {
        selectRepository(selectedRepo);
      }
    }, (err: Error) => {
      output?.appendLine(`Error selecting repository: ${err.message}`);
      vscode.window.showErrorMessage(`Branch Review: unable to select repository: ${err.message}`);
    });
  });
  currentPanel.onDidDispose(() => {
    disposed = true;
    editorListener.dispose();
    if (panel === currentPanel) panel = undefined;
  }, null, context.subscriptions);

  currentPanel.webview.onDidReceiveMessage(
    (message: WebviewMessage) => {
      if (message.type === "ready") {
        ready = true;
        loadRepository();
      } else if (!busy) {
        busy = true;
        const repoRoot = currentRepo.rootUri.fsPath;
        const action = message.type === "refresh"
          ? refreshBranches(currentPanel.webview, repoRoot)
          : message.type === "clear"
            ? handleClear(currentPanel.webview, repoRoot)
            : handleDownload(currentPanel.webview, message, repoRoot);
        void action.finally(() => {
          busy = false;
          if (pendingRepo) {
            const selectedRepo = pendingRepo;
            pendingRepo = undefined;
            selectRepository(selectedRepo);
          }
        });
      }
    },
    undefined,
    context.subscriptions,
  );
  currentPanel.webview.html = getHtml(currentPanel.webview);
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
    const { branches, warnings } = await listBranches(repoRoot);
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
    });
  } catch (err) {
    if (!isCurrent()) return;
    const text = `Unable to list repository branches: ${(err as Error).message}`;
    output?.appendLine(`Error: ${text}`);
    webview.postMessage({ type: "initError", text });
  }
}

async function refreshBranches(webview: vscode.Webview, repoRoot: string): Promise<void> {
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

async function handleClear(webview: vscode.Webview, repoRoot: string): Promise<void> {
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
    const baseline = await downloadBranch(
      repoRoot,
      branches[0],
      "baseline",
      log,
    );
    log(`Downloading target "${branches[1]}"`);
    const target = await downloadBranch(repoRoot, branches[1], "target", log);
    const reviewDir = await generateAiReviewBundle(
      repoRoot,
      baseline,
      target,
      log,
    );
    const summary = `Downloaded baseline "${baseline.branch}" and target "${target.branch}"; AI review data generated in ${reviewDir}`;
    output?.appendLine(summary);
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
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; max-width: 520px; }
    h2 { font-weight: 600; margin-top: 0; }
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
      margin-top: 18px; padding: 6px 14px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none;
    }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.6; cursor: default; }
    #clear, #refresh { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); margin-left: 8px; }
    #clear:hover:not(:disabled), #refresh:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    #project { overflow-wrap: anywhere; }
    #status { margin-top: 16px; white-space: pre-wrap; font-size: 12px; }
    .error { color: var(--vscode-errorForeground); }
    .muted { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h2>Branch Review</h2>
  <div id="project" class="muted">Loading project...</div>
  <form id="form">
    <label for="baseline">Baseline branch (old code)</label>
    <div class="branch-row">
      <input id="baseline" autocomplete="off" placeholder="Type or select a branch">
      <select id="baselineBranches" aria-label="Select baseline branch" disabled></select>
    </div>
    <label for="target">Target branch (new code changes)</label>
    <div class="branch-row">
      <input id="target" autocomplete="off" placeholder="Type or select a branch">
      <select id="targetBranches" aria-label="Select target branch" disabled></select>
    </div>
    <button id="refresh" type="button" disabled>Refresh branches</button>
    <button id="download" type="submit" disabled>Download</button>
    <button id="clear" type="button">Clear .branchReview</button>
  </form>
  <div id="status" class="muted">Loading branches...</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const baseline = document.getElementById('baseline');
    const target = document.getElementById('target');
    const button = document.getElementById('download');
    const clearButton = document.getElementById('clear');
    const refreshButton = document.getElementById('refresh');
    const project = document.getElementById('project');
    const baselineBranches = document.getElementById('baselineBranches');
    const targetBranches = document.getElementById('targetBranches');
    const status = document.getElementById('status');
    let isBusy = false;
    let isLoading = true;
    let isRefreshing = false;
    let baselineEdited = false;
    let targetEdited = false;

    function updateDownloadState() {
      const base = baseline.value.trim();
      const head = target.value.trim();
      button.disabled = isBusy || isLoading || isRefreshing || !base || !head || base === head;
      refreshButton.disabled = isBusy || isLoading || isRefreshing;
      clearButton.disabled = isBusy || isLoading || isRefreshing;
      baselineBranches.disabled = isBusy || isLoading || isRefreshing;
      targetBranches.disabled = isBusy || isLoading || isRefreshing;
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

    refreshButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'project':
          project.textContent = 'Project: ' + message.name;
          project.title = message.repoRoot;
          baseline.value = '';
          target.value = '';
          baselineEdited = false;
          targetEdited = false;
          populateBranches([]);
          isLoading = true;
          status.className = 'muted';
          status.textContent = 'Loading branches...';
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
          status.className = message.warnings.length ? 'error' : 'muted';
          status.textContent = message.warnings.join('\\n') ||
            (branches.length ? '' : 'No branches found. You can type branch names.');
          updateDownloadState();
          break;
        case 'refreshing':
          isRefreshing = message.refreshing;
          refreshButton.textContent = isRefreshing ? 'Refreshing...' : 'Refresh branches';
          if (isRefreshing) {
            status.className = 'muted';
            status.textContent = 'Refreshing branches...';
          }
          updateDownloadState();
          break;
        case 'refreshed':
          populateBranches(message.branches);
          status.className = message.warnings.length ? 'error' : 'muted';
          status.textContent = message.warnings.join('\\n') ||
            (message.branches.length ? 'Branches refreshed.' : 'No branches found. You can type branch names.');
          updateDownloadState();
          break;
        case 'busy':
          isBusy = message.busy;
          baseline.disabled = isBusy;
          target.disabled = isBusy;
          updateDownloadState();
          button.textContent = message.busy ? 'Downloading...' : 'Download';
          break;
        case 'progress':
          status.className = 'muted';
          status.textContent = message.text;
          break;
        case 'done':
          status.className = 'muted';
          status.textContent = message.text;
          break;
        case 'error':
          status.className = 'error';
          status.textContent = message.text;
          break;
        case 'initError':
          isLoading = false;
          status.className = 'error';
          status.textContent = message.text;
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

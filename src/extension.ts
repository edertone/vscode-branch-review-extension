import * as vscode from 'vscode';
import { clearBranchReview, downloadBranch, getCurrentBranchName } from './git';

const DEFAULT_SECOND_BRANCH = 'develop';

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
  | { type: 'ready' }
  | { type: 'download'; first: string; second: string }
  | { type: 'clear' };

let panel: vscode.WebviewPanel | undefined;
let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Branch Review');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('branchReview.open', () => openPanel(context))
  );
}

export function deactivate(): void {
  panel?.dispose();
}

async function getGitApi(): Promise<GitApi | undefined> {
  const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!gitExtension) {
    return undefined;
  }
  const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  return exports.getAPI(1);
}

/** Picks the repository of the active editor, falling back to the first open repository. */
async function findRepository(): Promise<GitRepository | undefined> {
  const api = await getGitApi();
  const repos = api?.repositories ?? [];
  if (repos.length === 0) {
    return undefined;
  }
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activeFile) {
    const match = repos
      .filter(r => activeFile.startsWith(r.rootUri.fsPath + '/') || activeFile === r.rootUri.fsPath)
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (match) {
      return match;
    }
  }
  return repos[0];
}

async function openPanel(context: vscode.ExtensionContext): Promise<void> {
  if (panel) {
    panel.reveal();
    return;
  }

  const repo = await findRepository();
  if (!repo) {
    vscode.window.showErrorMessage('Branch Review: no git repository found in the workspace.');
    return;
  }
  const repoRoot = repo.rootUri.fsPath;
  const currentBranch = (await getCurrentBranchName(repoRoot)) ?? repo.state.HEAD?.name ?? '';

  panel = vscode.window.createWebviewPanel(
    'branchReview',
    'Branch Review',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = getHtml(panel.webview);
  panel.onDidDispose(() => (panel = undefined), null, context.subscriptions);

  panel.webview.onDidReceiveMessage(
    (message: WebviewMessage) => {
      if (message.type === 'ready') {
        panel?.webview.postMessage({
          type: 'init',
          first: currentBranch,
          second: DEFAULT_SECOND_BRANCH,
          repoRoot
        });
      } else if (message.type === 'clear') {
        handleClear(repoRoot);
      } else {
        handleDownload(message, repoRoot);
      }
    },
    undefined,
    context.subscriptions
  );
}

async function handleClear(repoRoot: string): Promise<void> {
  if (!panel) {
    return;
  }
  const webview = panel.webview;
  const confirm = await vscode.window.showWarningMessage(
    'Delete the .branchReview folder and all downloaded branches?',
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') {
    return;
  }

  webview.postMessage({ type: 'busy', busy: true });
  try {
    const removed = await clearBranchReview(repoRoot);
    const text = removed ? 'Deleted .branchReview.' : 'Nothing to delete: .branchReview does not exist.';
    output?.appendLine(text);
    webview.postMessage({ type: 'done', text });
  } catch (err) {
    const text = (err as Error).message;
    output?.appendLine(`Error: ${text}`);
    webview.postMessage({ type: 'error', text });
  } finally {
    webview.postMessage({ type: 'busy', busy: false });
  }
}

async function handleDownload(message: WebviewMessage, repoRoot: string): Promise<void> {
  if (message.type !== 'download' || !panel) {
    return;
  }
  const webview = panel.webview;
  const branches = [message.first.trim(), message.second.trim()];

  if (branches.some(b => !b)) {
    webview.postMessage({ type: 'error', text: 'Both branch names are required.' });
    return;
  }
  if (branches[0] === branches[1]) {
    webview.postMessage({ type: 'error', text: 'Please choose two different branches.' });
    return;
  }

  const log = (text: string) => {
    output?.appendLine(text);
    webview.postMessage({ type: 'progress', text });
  };

  webview.postMessage({ type: 'busy', busy: true });
  try {
    const folders: string[] = [];
    for (const branch of branches) {
      log(`Downloading "${branch}"`);
      folders.push(await downloadBranch(repoRoot, branch, log));
    }
    const summary = `Downloaded ${branches.join(' and ')} to ${folders.join(', ')}`;
    output?.appendLine(summary);
    webview.postMessage({ type: 'done', text: summary });
    vscode.window.showInformationMessage(`Branch Review: ${summary}`);
  } catch (err) {
    const text = (err as Error).message;
    output?.appendLine(`Error: ${text}`);
    webview.postMessage({ type: 'error', text });
  } finally {
    webview.postMessage({ type: 'busy', busy: false });
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
    input {
      box-sizing: border-box; width: 100%; padding: 6px 8px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); outline: none;
    }
    input:focus { border-color: var(--vscode-focusBorder); }
    button {
      margin-top: 18px; padding: 6px 14px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none;
    }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.6; cursor: default; }
    #clear { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); margin-left: 8px; }
    #clear:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    #status { margin-top: 16px; white-space: pre-wrap; font-size: 12px; }
    .error { color: var(--vscode-errorForeground); }
    .muted { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h2>Branch Review</h2>
  <form id="form">
    <label for="first">First branch</label>
    <input id="first" type="text" spellcheck="false" autocomplete="off" />
    <label for="second">Second branch</label>
    <input id="second" type="text" spellcheck="false" autocomplete="off" />
    <button id="download" type="submit">Download</button>
    <button id="clear" type="button">Clear .branchReview</button>
  </form>
  <div id="status" class="muted"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const first = document.getElementById('first');
    const second = document.getElementById('second');
    const button = document.getElementById('download');
    const clearButton = document.getElementById('clear');
    const status = document.getElementById('status');

    document.getElementById('form').addEventListener('submit', event => {
      event.preventDefault();
      vscode.postMessage({ type: 'download', first: first.value, second: second.value });
    });

    clearButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'init':
          first.value = message.first;
          second.value = message.second;
          status.textContent = 'Repository: ' + message.repoRoot;
          break;
        case 'busy':
          button.disabled = message.busy;
          clearButton.disabled = message.busy;
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
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

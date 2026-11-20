import * as vscode from "vscode";
import * as path from "path";
import { listAnalysisResults, resultsRoot, runAnalysis } from "./analysis";
import { ANALYSIS_PROFILES, findAnalysisProfile } from "./analysisProfiles";
import {
  BRANCH_REVIEW_DIR,
  RESULTS_DIR,
  clearBranchReview,
  getCurrentBranchName,
  listBranches,
  readBranchReview,
  rebuildBranchReview,
} from "./git";

const DEFAULT_BASELINE_BRANCH = "develop";
const VIEW_ID = "branchReview.view";
const MODEL_STATE_KEY = "branchReview.analysis.modelId";
const MODEL_USAGE_KEY = "branchReview.analysis.modelUsage";
const MAX_GUIDE_CHARS = 20_000;
const RESULT_ID_PATTERN = /^[0-9A-Za-z-]+$/;

function guideStateKey(profileId: string): string {
  return `branchReview.analysis.guide.${profileId}`;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: { name?: string } };
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository(
    listener: (repository: GitRepository) => void,
  ): vscode.Disposable;
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

type WebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "download"; baseline: string; target: string }
  | { type: "clear" }
  | { type: "analyze"; profileId: string; modelId: string; guide: string }
  | { type: "cancelAnalysis" }
  | { type: "selectAnalysisModel"; modelId: string }
  | { type: "resetGuide"; profileId: string }
  | { type: "openResult"; id: string };

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
  let analysisController: AbortController | undefined;
  let analysisStateRevision = 0;
  const viewSubscriptions: vscode.Disposable[] = [];

  const disposeView = () => {
    if (disposed) return;
    disposed = true;
    analysisController?.abort();
    folderWatcher?.dispose();
    if (folderChangeTimer) clearTimeout(folderChangeTimer);
    for (const subscription of viewSubscriptions) {
      subscription.dispose();
    }
  };
  context.subscriptions.push({ dispose: disposeView });
  viewSubscriptions.push(currentView.onDidDispose(disposeView));

  const postAnalysisState = () => {
    if (!currentRepo || disposed) return;
    const repoRoot = currentRepo.rootUri.fsPath;
    const currentStateRevision = ++analysisStateRevision;
    void buildAnalysisState(context, repoRoot).then(
      (state) => {
        if (!disposed && currentStateRevision === analysisStateRevision) {
          void webview.postMessage(state);
        }
      },
      (err: Error) => {
        output?.appendLine(`Error reading analysis state: ${err.message}`);
      },
    );
  };
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
          postAnalysisState();
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
    postAnalysisState();
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
          const activeFile =
            vscode.window.activeTextEditor?.document.uri.fsPath;
          if (
            currentRepo &&
            (!activeFile ||
              (activeFile !== repository.rootUri.fsPath &&
                !activeFile.startsWith(repository.rootUri.fsPath + path.sep)))
          ) {
            return;
          }
          const selectedEditorRevision = ++editorRevision;
          void findRepository(activeFile).then(
            (selectedRepo) => {
              if (
                !disposed &&
                selectedEditorRevision === editorRevision &&
                selectedRepo
              ) {
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
    vscode.lm.onDidChangeChatModels(() => postAnalysisState()),
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
      } else if (message.type === "cancelAnalysis") {
        analysisController?.abort();
      } else if (message.type === "selectAnalysisModel") {
        void selectAnalysisModel(context, message.modelId);
      } else if (message.type === "resetGuide") {
        if (!findAnalysisProfile(message.profileId)) return;
        void context.workspaceState
          .update(guideStateKey(message.profileId), undefined)
          .then(postAnalysisState);
      } else if (message.type === "openResult") {
        if (currentRepo) {
          void openAnalysisReport(currentRepo.rootUri.fsPath, message.id);
        }
      } else if (message.type === "analyze" && busy) {
        void webview.postMessage({
          type: "analysisError",
          text: "Another Branch Review operation is running. Wait for it to finish, then analyze.",
        });
      } else if (!busy) {
        if (!currentRepo) {
          void webview.postMessage({
            type: "error",
            text: "No Git repository is available for Branch Review.",
          });
          return;
        }
        const repoRoot = currentRepo.rootUri.fsPath;
        if (message.type === "analyze") {
          const controller = new AbortController();
          analysisController = controller;
          void webview.postMessage({ type: "analysisRunning", running: true });
          runExclusive(() =>
            handleAnalyze(
              context,
              webview,
              message,
              repoRoot,
              controller.signal,
            ).finally(() => {
              analysisController = undefined;
              void webview.postMessage({
                type: "analysisRunning",
                running: false,
              });
            }),
          );
          return;
        }
        runExclusive(() =>
          message.type === "refresh"
            ? refreshBranches(webview, repoRoot)
            : message.type === "clear"
              ? handleClear(webview, repoRoot)
              : handleDownload(webview, message, repoRoot),
        );
      }
    }),
  );
  webview.html = getHtml(webview);

  function runExclusive(action: () => Promise<void>): void {
    busy = true;
    void action().finally(() => {
      busy = false;
      postAnalysisState();
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
    "Delete the .branchReview folder, all downloaded branches, and saved analysis results?",
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
      async ({ role, branch, ref, commit, reason }) => {
        const choice = await vscode.window.showWarningMessage(
          `Branch Review: could not fetch ${role} branch "${branch}".`,
          {
            modal: true,
            detail: `${reason}\n\nUse local ${ref} at ${commit}? This data may be out of date.`,
          },
          "Use Local Data",
        );
        return choice === "Use Local Data";
      },
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

async function listChatModels(): Promise<vscode.LanguageModelChat[]> {
  try {
    return await vscode.lm.selectChatModels();
  } catch (err) {
    output?.appendLine(`Unable to list AI models: ${(err as Error).message}`);
    return [];
  }
}

async function selectAnalysisModel(
  context: vscode.ExtensionContext,
  modelId: string,
): Promise<void> {
  if (typeof modelId !== "string" || !(await listChatModels()).some((model) => model.id === modelId)) {
    return;
  }
  await context.globalState.update(MODEL_STATE_KEY, modelId);
}

async function buildAnalysisState(
  context: vscode.ExtensionContext,
  repoRoot: string,
): Promise<Record<string, unknown>> {
  const models = await listChatModels();
  const modelUsage = context.globalState.get<Record<string, number>>(
    MODEL_USAGE_KEY,
    {},
  );
  return {
    type: "analysisState",
    models: models
      .map((model) => ({
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        usage: modelUsage[model.id] ?? 0,
      }))
      .sort(
        (left, right) =>
          right.usage - left.usage || left.name.localeCompare(right.name),
      ),
    selectedModelId:
      context.globalState.get<string>(MODEL_STATE_KEY) ??
      context.workspaceState.get<string>(MODEL_STATE_KEY),
    profiles: ANALYSIS_PROFILES.map((profile) => ({
      id: profile.id,
      label: profile.label,
      defaultGuide: profile.guide,
      guide:
        context.workspaceState.get<string>(guideStateKey(profile.id)) ??
        profile.guide,
    })),
    results: await listAnalysisResults(repoRoot),
  };
}

async function sendToModel(
  model: vscode.LanguageModelChat,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const source = new vscode.CancellationTokenSource();
  const cancel = () => source.cancel();
  signal.addEventListener("abort", cancel);
  if (signal.aborted) {
    source.cancel();
  }
  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {},
      source.token,
    );
    let text = "";
    for await (const fragment of response.text) {
      text += fragment;
    }
    return text;
  } finally {
    signal.removeEventListener("abort", cancel);
    source.dispose();
  }
}

async function handleAnalyze(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  message: Extract<WebviewMessage, { type: "analyze" }>,
  repoRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const fail = (text: string) => {
    output?.appendLine(`Analysis error: ${text}`);
    webview.postMessage({ type: "analysisError", text });
  };
  const profile = findAnalysisProfile(message.profileId);
  if (!profile) {
    return fail("Choose a valid code profile.");
  }
  const guide = typeof message.guide === "string" ? message.guide : "";
  if (!guide.trim()) {
    return fail("The analysis guide cannot be empty.");
  }
  if (guide.length > MAX_GUIDE_CHARS) {
    return fail(
      `The analysis guide cannot be longer than ${MAX_GUIDE_CHARS} characters.`,
    );
  }
  const chatModel = (await listChatModels()).find(
    (model) => model.id === message.modelId,
  );
  if (!chatModel) {
    return fail(
      "The selected AI model is not available. Choose another model and try again.",
    );
  }

  const guideCustomized = guide.trim() !== profile.guide.trim();
  await context.globalState.update(MODEL_STATE_KEY, chatModel.id);
  await context.workspaceState.update(
    guideStateKey(profile.id),
    guideCustomized ? guide : undefined,
  );

  output?.appendLine(
    `Analysis started: ${profile.label} profile with ${chatModel.name}`,
  );
  try {
    const meta = await runAnalysis({
      repoRoot,
      profile,
      guide,
      guideCustomized,
      model: {
        id: chatModel.id,
        name: chatModel.name,
        maxInputTokens: chatModel.maxInputTokens,
      },
      signal,
      sendPrompt: (prompt, promptSignal) =>
        sendToModel(chatModel, prompt, promptSignal),
      onProgress: (text) => {
        output?.appendLine(text);
        webview.postMessage({ type: "analysisProgress", text });
      },
    });
    const modelUsage = context.globalState.get<Record<string, number>>(
      MODEL_USAGE_KEY,
      {},
    );
    await context.globalState.update(MODEL_USAGE_KEY, {
      ...modelUsage,
      [chatModel.id]: (modelUsage[chatModel.id] ?? 0) + 1,
    });
    const text = `Analysis saved to ${path.join(BRANCH_REVIEW_DIR, RESULTS_DIR, meta.reportFile)}`;
    output?.appendLine(text);
    webview.postMessage({ type: "analysisDone", text });
  } catch (err) {
    if (signal.aborted) {
      output?.appendLine("Analysis cancelled.");
      webview.postMessage({
        type: "analysisProgress",
        text: "Analysis cancelled.",
      });
      return;
    }
    fail((err as Error).message);
  }
}

async function openAnalysisReport(repoRoot: string, id: string): Promise<void> {
  if (!RESULT_ID_PATTERN.test(id)) {
    vscode.window.showErrorMessage(
      "Branch Review: invalid analysis result id.",
    );
    return;
  }
  const reportPath = path.join(resultsRoot(repoRoot), `${id}.md`);
  try {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(reportPath),
    );
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Branch Review: unable to open analysis report: ${(err as Error).message}`,
    );
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
    #reviewSummary { margin-top: 8px; white-space: pre-wrap; }
    #reviewActions { display: flex; flex-wrap: wrap; gap: 8px; }
    #reviewActions button { margin: 12px 0 0; }
    #reviewTabs { display: flex; gap: 4px; margin-top: 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    #reviewTabs button { margin-top: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--vscode-foreground); }
    #reviewTabs button[aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder); }
    #reviewPanels { max-width: 760px; }
    #branchesPanel, #resultsPanel { margin-top: 20px; }
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
    #analysisPanel select, #analysisPanel textarea, #analysisPanel input { margin-top: 4px; }
    #analysisModelRow { display: flex; gap: 8px; align-items: center; }
    #analysisModelInput { flex: 1; min-width: 0; }
    #selectAnalysisModel { flex: 0 0 auto; margin-top: 4px; }
    #analysisModelDialog { z-index: 20; }
    #analysisModelList { max-height: 45vh; overflow: auto; margin: 8px 0; padding: 0; list-style: none; }
    .analysis-model-option { display: block; width: 100%; margin: 0; padding: 8px; text-align: left; background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; }
    .analysis-model-option:hover, .analysis-model-option[aria-selected="true"] { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
    #analysisGuide { box-sizing: border-box; width: 100%; min-height: 100px; resize: vertical; padding: 6px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
    #analysisGuide:focus { border-color: var(--vscode-focusBorder); }
    #analysisActions { display: flex; flex-wrap: wrap; gap: 8px; }
    #analysisActions button { margin: 12px 0 0; }
    #analysisStatus { margin-top: 12px; white-space: pre-wrap; font-size: 12px; }
    #analysisResults { margin-top: 8px; }
    .result-row { padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; }
    .result-row button { margin: 4px 0 0; }
  </style>
</head>
<body>
  <h2>Branch Review</h2>
  <div id="project" class="muted">Loading project...</div>
  <div id="reviewSummary" class="muted" hidden></div>
  <div id="reviewActions">
    <button id="chooseBranches" type="button" disabled>Choose branches / Download</button>
    <button id="clear" class="secondary" type="button" disabled>Clear .branchReview</button>
  </div>
  <div id="reviewTabs" role="tablist" aria-label="Branch review" hidden>
    <button id="analysisTab" type="button" role="tab" aria-selected="true" aria-controls="analysisPanel" tabindex="0">Analysis</button>
    <button id="resultsTab" type="button" role="tab" aria-selected="false" aria-controls="resultsPanel" tabindex="-1">Results</button>
    <button id="branchesTab" type="button" role="tab" aria-selected="false" aria-controls="branchesPanel" tabindex="-1">Downloaded branches</button>
  </div>
  <div id="reviewPanels">
    <section id="analysisPanel" role="tabpanel" aria-labelledby="analysisTab" tabindex="0" hidden>
      <h3>Analyze changes</h3>
      <label for="analysisModelInput">AI model</label>
      <div id="analysisModelRow">
        <input id="analysisModelInput" aria-label="Selected AI model" placeholder="Select a model" readonly disabled>
        <button id="selectAnalysisModel" class="secondary" type="button" disabled>Select model</button>
      </div>
      <p id="analysisModelCount" class="muted" aria-live="polite"></p>
      <label for="analysisProfile">Code profile</label>
      <select id="analysisProfile" aria-label="Code profile" disabled></select>
      <label for="analysisGuide">Analysis guide for this profile (editable)</label>
      <textarea id="analysisGuide" spellcheck="false" disabled></textarea>
      <div id="analysisActions">
        <button id="analyze" type="button" disabled>Analyze</button>
        <button id="cancelAnalysis" class="secondary" type="button" hidden>Cancel analysis</button>
        <button id="resetGuide" class="secondary" type="button" disabled>Restore default guide</button>
      </div>
      <div id="analysisStatus" class="muted" aria-live="polite"></div>
    </section>
    <section id="resultsPanel" role="tabpanel" aria-labelledby="resultsTab" tabindex="0" hidden>
      <h3>Analysis results</h3>
      <div id="analysisResults" class="muted" aria-live="polite"></div>
    </section>
    <section id="branchesPanel" role="tabpanel" aria-labelledby="branchesTab" tabindex="0" hidden>
      <h3>Downloaded review data</h3>
      <div id="reviewDetails"></div>
      <ul id="changedFiles"></ul>
    </section>
  </div>
  <div id="noReview" class="muted">Checking .branchReview...</div>
  <div id="status" class="muted">Loading branches...</div>

  <div id="analysisModelDialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="analysisModelDialogTitle" hidden>
    <div class="modal-content">
      <h3 id="analysisModelDialogTitle">Select AI model</h3>
      <label for="analysisModelSearch">Search models</label>
      <input id="analysisModelSearch" type="search" placeholder="Search by model, provider, or ID" autocomplete="off">
      <ul id="analysisModelList" aria-label="Available AI models"></ul>
      <div class="modal-actions">
        <div id="analysisModelDialogStatus" class="muted" aria-live="polite"></div>
        <div class="modal-actions-end">
          <button id="cancelAnalysisModel" class="secondary" type="button">Cancel</button>
          <button id="confirmAnalysisModel" type="button" disabled>Select</button>
        </div>
      </div>
    </div>
  </div>

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
    const reviewSummary = document.getElementById('reviewSummary');
    const reviewTabs = document.getElementById('reviewTabs');
    const analysisTab = document.getElementById('analysisTab');
    const resultsTab = document.getElementById('resultsTab');
    const branchesTab = document.getElementById('branchesTab');
    const analysisPanel = document.getElementById('analysisPanel');
    const resultsPanel = document.getElementById('resultsPanel');
    const branchesPanel = document.getElementById('branchesPanel');
    const reviewDetails = document.getElementById('reviewDetails');
    const changedFiles = document.getElementById('changedFiles');
    const noReview = document.getElementById('noReview');
    const selectionModal = document.getElementById('selectionModal');
    const modalTitle = document.getElementById('modalTitle');
    const baselineBranches = document.getElementById('baselineBranches');
    const targetBranches = document.getElementById('targetBranches');
    const status = document.getElementById('status');
    const modalStatus = document.getElementById('modalStatus');
    const analysisModelInput = document.getElementById('analysisModelInput');
    const analysisModelCount = document.getElementById('analysisModelCount');
    const selectAnalysisModelButton = document.getElementById('selectAnalysisModel');
    const analysisModelDialog = document.getElementById('analysisModelDialog');
    const analysisModelSearch = document.getElementById('analysisModelSearch');
    const analysisModelList = document.getElementById('analysisModelList');
    const analysisModelDialogStatus = document.getElementById('analysisModelDialogStatus');
    const cancelAnalysisModelButton = document.getElementById('cancelAnalysisModel');
    const confirmAnalysisModelButton = document.getElementById('confirmAnalysisModel');
    const analysisProfile = document.getElementById('analysisProfile');
    const analysisGuide = document.getElementById('analysisGuide');
    const analyzeButton = document.getElementById('analyze');
    const cancelAnalysisButton = document.getElementById('cancelAnalysis');
    const resetGuideButton = document.getElementById('resetGuide');
    const analysisStatus = document.getElementById('analysisStatus');
    const analysisResults = document.getElementById('analysisResults');
    let isBusy = false;
    let isLoading = true;
    let isRefreshing = false;
    let isAnalysisRunning = false;
    let baselineEdited = false;
    let targetEdited = false;
    let hasValidReview = false;
    let activeReviewTab = 'analysis';
    let analysisProfiles = [];
    let analysisModels = [];
    let pendingAnalysisModelId = '';
    const analysisDrafts = {};

    function selectReviewTab(tab) {
      activeReviewTab = tab;
      for (const [name, button, panel] of [
        ['analysis', analysisTab, analysisPanel],
        ['results', resultsTab, resultsPanel],
        ['branches', branchesTab, branchesPanel]
      ]) {
        const selected = tab === name;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        panel.hidden = !selected;
      }
    }

    const reviewTabEntries = [
      ['analysis', analysisTab],
      ['results', resultsTab],
      ['branches', branchesTab]
    ];
    for (const [name, tab] of reviewTabEntries) {
      tab.addEventListener('click', () => selectReviewTab(name));
      tab.addEventListener('keydown', event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const currentIndex = reviewTabEntries.findIndex(entry => entry[0] === name);
          const offset = event.key === 'ArrowRight' ? 1 : -1;
          const next = reviewTabEntries[(currentIndex + offset + reviewTabEntries.length) % reviewTabEntries.length];
          selectReviewTab(next[0]);
          next[1].focus();
        }
      });
    }

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
        activeReviewTab = 'analysis';
        selectReviewTab(activeReviewTab);
        reviewTabs.hidden = true;
        reviewSummary.hidden = true;
        branchesPanel.hidden = true;
        resultsPanel.hidden = true;
        noReview.hidden = false;
        noReview.textContent = review && review.reason
          ? 'No valid downloaded review: ' + review.reason
          : 'No valid downloaded review. Choose branches to create one.';
        showPicker(true);
        return;
      }
      reviewTabs.hidden = false;
      selectReviewTab(activeReviewTab);
      reviewSummary.hidden = false;
      noReview.hidden = true;
      reviewSummary.textContent =
        'Baseline: ' + review.baseline.branch + ' (' + review.baseline.commit.slice(0, 8) + ')\\n' +
        'Target: ' + review.target.branch + ' (' + review.target.commit.slice(0, 8) + ')\\n' +
        'Generated: ' + review.generatedAt;
      reviewDetails.textContent =
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
      button.disabled = isBusy || isLoading || isRefreshing || isAnalysisRunning || !base || !head || base === head;
      refreshButton.disabled = isBusy || isLoading || isRefreshing || isAnalysisRunning;
      clearButton.disabled = isBusy || isLoading || isRefreshing || isAnalysisRunning;
      chooseButton.disabled = isBusy || isLoading || isRefreshing || isAnalysisRunning;
      baselineBranches.disabled = isBusy || isLoading || isRefreshing || isAnalysisRunning;
      targetBranches.disabled = isBusy || isLoading || isRefreshing || isAnalysisRunning;
      baseline.disabled = isBusy || isLoading || isRefreshing || isAnalysisRunning;
      target.disabled = isBusy || isLoading || isRefreshing || isAnalysisRunning;
      updateAnalysisState();
    }

    function updateAnalysisState() {
      const unavailable = isBusy || isLoading || isRefreshing || isAnalysisRunning;
      const hasModel = analysisModels.some(model => model.id === analysisModelInput.dataset.modelId);
      const hasGuide = analysisGuide.value.trim() !== '';
      analysisModelInput.disabled = unavailable || analysisModels.length === 0;
      selectAnalysisModelButton.disabled = unavailable || analysisModels.length === 0;
      analysisProfile.disabled = unavailable;
      analysisGuide.disabled = unavailable;
      resetGuideButton.disabled = unavailable;
      analyzeButton.disabled = unavailable || !hasValidReview || !hasModel || !hasGuide;
      cancelAnalysisButton.hidden = !isAnalysisRunning;
    }

    function currentAnalysisProfile() {
      return analysisProfiles.find(profile => profile.id === analysisProfile.value);
    }

    function showProfileGuide() {
      const profile = currentAnalysisProfile();
      const guide = profile ? (analysisDrafts[profile.id] ?? profile.guide) : '';
      if (analysisGuide.value !== guide) {
        analysisGuide.value = guide;
      }
      updateAnalysisState();
    }

    function renderAnalysisState(state) {
      analysisModels = state.models;
      const previousSelectedModelId = analysisModelInput.dataset.modelId;
      const previousModel = state.models.find(model => model.id === previousSelectedModelId);
      const selectedModel = previousModel || state.models.find(model => model.id === state.selectedModelId);
      analysisModelInput.dataset.modelId = selectedModel ? selectedModel.id : '';
      analysisModelInput.value = selectedModel ? selectedModel.name + ' (' + selectedModel.vendor + ')' : '';
      analysisModelCount.textContent = state.models.length === 0
        ? 'No AI models available. Sign in to GitHub Copilot or another model provider.'
        : state.models.length + ' available model' + (state.models.length === 1 ? '' : 's');
      renderAnalysisModelChoices();

      analysisProfiles = state.profiles;
      const previousProfile = analysisProfile.value;
      analysisProfile.replaceChildren();
      for (const profile of state.profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.label;
        analysisProfile.appendChild(option);
      }
      analysisProfile.value = state.profiles.some(profile => profile.id === previousProfile)
        ? previousProfile
        : (state.profiles[0] ? state.profiles[0].id : '');
      showProfileGuide();

      analysisResults.replaceChildren();
      if (state.results.length === 0) {
        analysisResults.textContent = 'No analyses yet. Results are saved in .branchReview/results.';
        return;
      }
      for (const result of state.results) {
        const row = document.createElement('div');
        row.className = 'result-row';
        const info = document.createElement('div');
        const skipped = result.skippedFiles.length
          ? ' · ' + result.skippedFiles.length + ' not analyzed'
          : '';
        info.textContent = result.profileLabel + ' · ' + result.target.branch + ' vs ' + result.baseline.branch +
          ' · ' + result.model.name + ' · ' + new Date(result.createdAt).toLocaleString() +
          ' · ' + result.analyzedFiles + ' of ' + result.relevantFiles + ' files' + skipped +
          (result.guideCustomized ? ' · edited guide' : '');
        const open = document.createElement('button');
        open.className = 'secondary';
        open.type = 'button';
        open.textContent = 'Open Markdown report';
        open.setAttribute('aria-label', 'Open Markdown report for ' + result.profileLabel + ' analysis');
        open.addEventListener('click', () => {
          vscode.postMessage({ type: 'openResult', id: result.id });
        });
        row.appendChild(info);
        row.appendChild(open);
        analysisResults.appendChild(row);
      }
    }

    function renderAnalysisModelChoices() {
      const query = analysisModelSearch.value.trim().toLocaleLowerCase();
      const models = analysisModels.filter(model =>
        (model.name + ' ' + model.vendor + ' ' + model.id).toLocaleLowerCase().includes(query));
      const selectedId = analysisModelInput.dataset.modelId;
      analysisModelList.replaceChildren();
      for (const model of models) {
        const item = document.createElement('li');
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'analysis-model-option';
        option.textContent = model.name + ' (' + model.vendor + ')';
        option.setAttribute('aria-selected', String(model.id === pendingAnalysisModelId));
        option.addEventListener('click', () => {
          pendingAnalysisModelId = model.id;
          confirmAnalysisModelButton.disabled = false;
          for (const candidate of analysisModelList.children) {
            candidate.firstChild.setAttribute('aria-selected', String(candidate.firstChild === option));
          }
        });
        item.appendChild(option);
        analysisModelList.appendChild(item);
      }
      analysisModelDialogStatus.textContent = models.length
        ? models.length + ' model' + (models.length === 1 ? '' : 's') + (selectedId ? ' · currently selected model is highlighted' : '')
        : 'No models match your search.';
    }

    function openAnalysisModelDialog() {
      pendingAnalysisModelId = analysisModelInput.dataset.modelId || '';
      analysisModelSearch.value = '';
      confirmAnalysisModelButton.disabled = !pendingAnalysisModelId;
      renderAnalysisModelChoices();
      analysisModelDialog.hidden = false;
      analysisModelSearch.focus();
    }

    function closeAnalysisModelDialog() {
      analysisModelDialog.hidden = true;
      selectAnalysisModelButton.focus();
    }

    analysisProfile.addEventListener('change', showProfileGuide);
    selectAnalysisModelButton.addEventListener('click', openAnalysisModelDialog);
    analysisModelSearch.addEventListener('input', renderAnalysisModelChoices);
    cancelAnalysisModelButton.addEventListener('click', closeAnalysisModelDialog);
    analysisModelDialog.addEventListener('click', event => {
      if (event.target === analysisModelDialog) closeAnalysisModelDialog();
    });
    confirmAnalysisModelButton.addEventListener('click', () => {
      const model = analysisModels.find(candidate => candidate.id === pendingAnalysisModelId);
      if (!model) return;
      analysisModelInput.dataset.modelId = model.id;
      analysisModelInput.value = model.name + ' (' + model.vendor + ')';
      vscode.postMessage({ type: 'selectAnalysisModel', modelId: model.id });
      closeAnalysisModelDialog();
      updateAnalysisState();
    });
    analysisGuide.addEventListener('input', () => {
      const profile = currentAnalysisProfile();
      if (profile) {
        analysisDrafts[profile.id] = analysisGuide.value;
      }
      updateAnalysisState();
    });
    analyzeButton.addEventListener('click', () => {
      const profile = currentAnalysisProfile();
      if (!profile || analyzeButton.disabled) {
        return;
      }
      analysisStatus.className = 'muted';
      analysisStatus.textContent = 'Starting analysis...';
      vscode.postMessage({
        type: 'analyze',
        profileId: profile.id,
        modelId: analysisModelInput.dataset.modelId,
        guide: analysisGuide.value,
      });
    });
    cancelAnalysisButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelAnalysis' });
    });
    resetGuideButton.addEventListener('click', () => {
      const profile = currentAnalysisProfile();
      if (!profile) {
        return;
      }
      delete analysisDrafts[profile.id];
      analysisGuide.value = profile.defaultGuide;
      updateAnalysisState();
      vscode.postMessage({ type: 'resetGuide', profileId: profile.id });
    });

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
        case 'analysisState':
          renderAnalysisState(message);
          break;
        case 'analysisRunning':
          isAnalysisRunning = message.running;
          if (message.running) {
            analysisStatus.className = 'muted';
            analysisStatus.textContent = 'Starting analysis...';
          }
          updateDownloadState();
          break;
        case 'analysisProgress':
          analysisStatus.className = 'muted';
          analysisStatus.textContent = message.text;
          break;
        case 'analysisDone':
          analysisStatus.className = 'muted';
          analysisStatus.textContent = message.text;
          break;
        case 'analysisError':
          analysisStatus.className = 'error';
          analysisStatus.textContent = message.text;
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

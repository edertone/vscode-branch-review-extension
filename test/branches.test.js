const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Module = require('node:module');
const extensionManifest = require('../package.json');
const {
  branchReviewRoot,
  listBranches,
  downloadBranch,
  readBranchReview,
  rebuildBranchReview
} = require('../out/git');
const { ANALYSIS_PROFILES, findAnalysisProfile, isRelevantToProfile } = require('../out/analysisProfiles');
const { listAnalysisResults, resultsRoot, runAnalysis } = require('../out/analysis');

test('analysis profiles provide default general-purpose and TypeScript guides with focused file matching', () => {
  assert.equal(ANALYSIS_PROFILES[0].id, 'general-purpose');
  assert.ok(findAnalysisProfile('general-purpose').guide.includes('any kind of software project'));
  assert.ok(findAnalysisProfile('typescript').guide.includes('TypeScript engineer'));
  assert.equal(isRelevantToProfile(findAnalysisProfile('general-purpose'), 'src/app.py'), true);
  assert.equal(isRelevantToProfile(findAnalysisProfile('typescript'), 'src/app.ts'), true);
  assert.equal(isRelevantToProfile(findAnalysisProfile('typescript'), 'src/app.java'), false);
  assert.equal(isRelevantToProfile(findAnalysisProfile('typescript'), 'src/types.d.ts'), false);
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-review-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const repo = path.join(root, 'repo');
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main', seed);
  git(seed, 'config', 'user.name', 'Test');
  git(seed, 'config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(seed, 'file.txt'), 'main\n');
  git(seed, 'add', 'file.txt');
  git(seed, 'commit', '-m', 'main');
  git(seed, 'branch', 'develop');
  git(seed, 'checkout', '-b', 'feature/not-fetched');
  await fs.writeFile(path.join(seed, 'file.txt'), 'feature\n');
  git(seed, 'commit', '-am', 'feature');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', 'origin', 'main', 'develop', 'feature/not-fetched');
  git(root, 'clone', '--single-branch', '--branch', 'main', remote, repo);
  git(repo, 'remote', 'add', 'upstream', remote);
  return { root, repo, seed };
}

test('discovers unfetched branches from every remote and downloads a selected remote branch', async t => {
  const { repo } = await fixture(t);
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(repo, 'branch', 'local-only');
  git(repo, 'update-ref', 'refs/remotes/origin/stale', git(repo, 'rev-parse', 'HEAD'));
  const result = await listBranches(repo);
  assert.deepEqual(result.warnings, []);
  for (const branch of ['main', 'local-only', 'origin/main', 'origin/develop', 'origin/feature/not-fetched', 'upstream/feature/not-fetched']) {
    assert.ok(result.branches.includes(branch), branch);
  }
  assert.ok(!result.branches.includes('origin/stale'));
  assert.ok(!result.branches.includes('origin/HEAD'));
  const snapshot = await downloadBranch(repo, 'upstream/feature/not-fetched', 'target', () => {});
  assert.equal(snapshot.branch, 'upstream/feature/not-fetched');
  assert.equal(await fs.readFile(path.join(snapshot.directory, 'file.txt'), 'utf8'), 'feature\n');
  assert.equal(snapshot.commit, git(repo, 'rev-parse', 'refs/remotes/upstream/feature/not-fetched'));
});

test('reports inaccessible remotes without suggesting cached remote branches', async t => {
  const { root, repo } = await fixture(t);
  git(repo, 'remote', 'add', 'broken', path.join(root, 'missing.git'));
  git(repo, 'update-ref', 'refs/remotes/broken/cached', git(repo, 'rev-parse', 'HEAD'));
  const result = await listBranches(repo);
  assert.ok(result.warnings.some(warning => warning.includes('broken')));
  assert.ok(result.branches.includes('main'));
  assert.ok(result.branches.includes('origin/develop'));
  assert.ok(!result.branches.includes('broken/cached'));
});

test('suggests local branches without a remote', async t => {
  const { repo } = await fixture(t);
  git(repo, 'remote', 'remove', 'origin');
  git(repo, 'remote', 'remove', 'upstream');
  const result = await listBranches(repo);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.branches, ['main']);
  await assert.rejects(
    downloadBranch(repo, 'main', 'baseline', () => {}),
    /Cannot fetch branch "main": remote "origin" is not configured/,
  );
  const confirmations = [];
  const snapshot = await downloadBranch(repo, 'main', 'baseline', () => {}, branchReviewRoot(repo), async fallback => {
    confirmations.push(fallback);
    return true;
  });
  assert.equal(confirmations[0].ref, 'refs/heads/main');
  assert.match(confirmations[0].reason, /remote "origin" is not configured/);
  assert.equal(await fs.readFile(path.join(snapshot.directory, 'file.txt'), 'utf8'), 'main\n');
});

test('downloads the latest remote commits for both branches', async t => {
  const { repo, seed } = await fixture(t);
  git(seed, 'checkout', 'main');
  await fs.writeFile(path.join(seed, 'file.txt'), 'updated main\n');
  git(seed, 'commit', '-am', 'update main');
  const mainCommit = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'checkout', 'feature/not-fetched');
  await fs.writeFile(path.join(seed, 'file.txt'), 'updated feature\n');
  git(seed, 'commit', '-am', 'update feature');
  const featureCommit = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', 'origin', 'main', 'feature/not-fetched');

  const review = await rebuildBranchReview(repo, 'main', 'upstream/feature/not-fetched', () => {});
  assert.equal(review.baseline.commit, mainCommit);
  assert.equal(review.target.commit, featureCommit);
  assert.equal(await fs.readFile(path.join(branchReviewRoot(repo), 'baseline', 'file.txt'), 'utf8'), 'updated main\n');
  assert.equal(await fs.readFile(path.join(branchReviewRoot(repo), 'target', 'file.txt'), 'utf8'), 'updated feature\n');
});

test('rejects failed fetches even when cached or local branches exist and preserves the review', async t => {
  const { root, repo, seed } = await fixture(t);
  const initial = await rebuildBranchReview(repo, 'main', 'origin/develop', () => {});
  git(repo, 'remote', 'set-url', 'upstream', path.join(root, 'missing.git'));
  git(repo, 'update-ref', 'refs/remotes/upstream/develop', git(repo, 'rev-parse', 'HEAD'));
  await assert.rejects(
    rebuildBranchReview(repo, 'main', 'upstream/develop', () => {}),
    /Cannot fetch branch "upstream\/develop" from "upstream"/,
  );
  assert.deepEqual(await readBranchReview(repo), initial);
  assert.deepEqual(
    (await fs.readdir(repo)).filter(name => name.startsWith('.branchReview.')),
    [],
  );

  git(seed, 'push', 'origin', '--delete', 'develop');
  git(repo, 'branch', 'develop');
  await assert.rejects(
    downloadBranch(repo, 'develop', 'target', () => {}),
    /Cannot fetch branch "develop" from "origin"/,
  );
  assert.deepEqual(await readBranchReview(repo), initial);
});

test('uses cached or local commits only after confirmation for each failed fetch', async t => {
  const { root, repo } = await fixture(t);
  git(repo, 'branch', 'local-only');
  git(repo, 'update-ref', 'refs/remotes/origin/local-only', git(repo, 'rev-parse', 'origin/main'));
  git(repo, 'update-ref', 'refs/remotes/upstream/develop', git(repo, 'rev-parse', 'HEAD'));
  git(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing-origin.git'));
  git(repo, 'remote', 'set-url', 'upstream', path.join(root, 'missing-upstream.git'));
  const prompts = [];
  const review = await rebuildBranchReview(repo, 'local-only', 'upstream/develop', () => {}, async fallback => {
    prompts.push(fallback);
    return true;
  });
  assert.deepEqual(prompts.map(({ role, ref }) => ({ role, ref })), [
    { role: 'baseline', ref: 'refs/remotes/origin/local-only' },
    { role: 'target', ref: 'refs/remotes/upstream/develop' },
  ]);
  assert.equal(review.baseline.commit, prompts[0].commit);
  assert.equal(review.target.commit, prompts[1].commit);
  assert.match(prompts[0].reason, /Cannot fetch branch "local-only"/);
  const manifest = JSON.parse(await fs.readFile(path.join(branchReviewRoot(repo), 'ai-review', 'manifest.json'), 'utf8'));
  assert.equal(manifest.baseline.source.type, 'local-fallback');
  assert.equal(manifest.baseline.source.ref, prompts[0].ref);
  assert.match(manifest.baseline.source.reason, /Cannot fetch/);

  git(repo, 'update-ref', '-d', 'refs/remotes/origin/local-only');
  const local = [];
  await rebuildBranchReview(repo, 'local-only', 'upstream/develop', () => {}, async fallback => {
    local.push(fallback);
    return true;
  });
  assert.equal(local[0].ref, 'refs/heads/local-only');

  let called = false;
  await assert.rejects(
    rebuildBranchReview(repo, 'missing-branch', 'upstream/develop', () => {}, async () => {
      called = true;
      return true;
    }),
    /No locally available commit can be used/,
  );
  assert.equal(called, false);
});

test('review bundle describes literal paths, binary and submodule changes, truncation, and divergent history', async t => {
  const { repo, seed } = await fixture(t);
  git(seed, 'checkout', 'main');
  await fs.writeFile(path.join(seed, 'baseline-only.txt'), 'baseline\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'baseline only');
  git(seed, 'checkout', 'feature/not-fetched');
  const specialPath = 'literal[ab].txt';
  await fs.writeFile(path.join(seed, specialPath), 'special\n');
  await fs.writeFile(path.join(seed, 'literala.txt'), 'glob-match\n');
  await fs.writeFile(path.join(seed, 'other.txt'), 'other\n');
  await fs.writeFile(path.join(seed, 'file.txt'), 'other.txt');
  await fs.writeFile(path.join(seed, 'image.bin'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(seed, 'legacy.txt'), Buffer.from([0xff, 0x0a]));
  await fs.writeFile(path.join(seed, 'large.txt'), 'long line for truncation\n'.repeat(15000));
  git(seed, 'add', '--all');
  const symlinkObject = git(seed, 'hash-object', '-w', path.join(seed, 'other.txt'));
  git(seed, 'update-index', '--add', '--cacheinfo', `120000,${symlinkObject},file.txt`);
  git(seed, 'update-index', '--add', '--cacheinfo', `160000,${git(seed, 'rev-parse', 'main')},module`);
  git(seed, '-c', 'user.name=Test', 'commit', '-m', 'target\x1echanges', '--date=2020-01-01T00:00:00Z');
  const targetCommit = git(seed, 'rev-parse', 'HEAD');
  const commitTime = git(seed, 'show', '-s', '--format=%cI', targetCommit);
  git(seed, 'push', 'origin', 'main', 'feature/not-fetched');

  git(repo, 'config', 'diff.ignoreSubmodules', 'all');
  await rebuildBranchReview(repo, 'main', 'feature/not-fetched', () => {});
  const review = path.join(branchReviewRoot(repo), 'ai-review');
  const manifest = JSON.parse(await fs.readFile(path.join(review, 'manifest.json'), 'utf8'));
  const { files } = JSON.parse(await fs.readFile(path.join(review, 'changed-files.json'), 'utf8'));
  const { commits } = JSON.parse(await fs.readFile(path.join(review, 'commits.json'), 'utf8'));
  const special = files.find(file => file.newPath === specialPath);
  const patch = await fs.readFile(path.join(review, special.diffFile), 'utf8');
  assert.match(patch, /\+special/);
  assert.doesNotMatch(patch, /\+other/);
  const binary = files.find(file => file.newPath === 'image.bin');
  assert.equal(binary.binary, true);
  assert.equal(binary.additions, null);
  assert.match(await fs.readFile(path.join(review, binary.diffFile), 'utf8'), /Binary files/);
  const legacy = files.find(file => file.newPath === 'legacy.txt');
  assert.ok((await fs.readFile(path.join(review, legacy.diffFile))).includes(Buffer.from([0x2b, 0xff, 0x0a])));
  const submodule = files.find(file => file.newPath === 'module');
  assert.equal(submodule.newMode, '160000');
  assert.equal(submodule.newObject, git(seed, 'rev-parse', 'main'));
  const symlink = files.find(file => file.newPath === 'file.txt');
  assert.equal(symlink.status, 'T');
  assert.equal(symlink.newMode, '120000');
  const large = files.find(file => file.newPath === 'large.txt');
  assert.equal(large.diffTruncated, true);
  assert.ok((await fs.stat(path.join(review, large.diffFile))).size <= manifest.limits.maxFileDiffBytes);
  assert.equal(manifest.summary.diffTruncated, true);
  assert.deepEqual(manifest.history, { baselineOnlyCommits: 1, targetOnlyCommits: 2, shallow: false });
  assert.equal(commits.find(commit => commit.commit === targetCommit).committedAt, commitTime);
  assert.equal(commits.find(commit => commit.commit === targetCommit).subject, 'target\x1echanges');
  assert.equal(manifest.target.source.type, 'remote');
});

test('marks shallow history as potentially incomplete', async t => {
  const { root } = await fixture(t);
  const repo = path.join(root, 'shallow');
  git(root, 'clone', '--depth=1', '--branch', 'main', `file://${path.join(root, 'remote.git')}`, repo);
  await rebuildBranchReview(repo, 'main', 'feature/not-fetched', () => {});
  const review = path.join(branchReviewRoot(repo), 'ai-review');
  const manifest = JSON.parse(await fs.readFile(path.join(review, 'manifest.json'), 'utf8'));
  const overview = await fs.readFile(path.join(review, 'overview.md'), 'utf8');
  assert.equal(manifest.history.shallow, true);
  assert.match(overview, /history is shallow/);
});

test('cancelled fallback preserves the previous review', async t => {
  const { root, repo } = await fixture(t);
  const initial = await rebuildBranchReview(repo, 'main', 'origin/develop', () => {});
  git(repo, 'remote', 'set-url', 'upstream', path.join(root, 'missing.git'));
  git(repo, 'update-ref', 'refs/remotes/upstream/develop', git(repo, 'rev-parse', 'HEAD'));
  await assert.rejects(
    rebuildBranchReview(repo, 'main', 'upstream/develop', () => {}, async () => false),
    /Download cancelled: fresh data for branch "upstream\/develop"/,
  );
  assert.deepEqual(await readBranchReview(repo), initial);
});

test('rebuilds the whole review folder and detects invalid saved data', async t => {
  const { repo } = await fixture(t);
  const root = branchReviewRoot(repo);
  assert.equal((await readBranchReview(repo)).valid, false);

  const first = await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});
  assert.equal(first.valid, true);
  assert.equal(first.baseline.branch, 'main');
  assert.equal(first.target.branch, 'origin/feature/not-fetched');
  assert.ok(first.files.some(file => file.path === 'file.txt'));

  await fs.writeFile(path.join(root, 'stale.txt'), 'remove on rebuild');
  const second = await rebuildBranchReview(repo, 'main', 'origin/develop', () => {});
  assert.equal(second.valid, true);
  await assert.rejects(fs.stat(path.join(root, 'stale.txt')), { code: 'ENOENT' });
  await assert.rejects(
    rebuildBranchReview(repo, 'missing-branch', 'develop', () => {}),
    /Cannot fetch branch "missing-branch" from "origin"/,
  );
  const preserved = await readBranchReview(repo);
  assert.equal(preserved.valid, true);
  assert.equal(preserved.target.branch, 'origin/develop');
  assert.deepEqual(
    (await fs.readdir(repo)).filter(name => name.startsWith('.branchReview.')),
    [],
  );

  await fs.writeFile(path.join(root, 'ai-review', 'manifest.json'), '{invalid');
  const invalid = await readBranchReview(repo);
  assert.equal(invalid.valid, false);
  assert.match(invalid.reason, /JSON|position|property/i);
});

test('webview initializes, shares branch suggestions, and accepts typed names', async t => {
  const { repo, seed } = await fixture(t);
  const [container] = extensionManifest.contributes.viewsContainers.secondarySidebar;
  assert.equal(container.id, 'branchReview');
  assert.equal(extensionManifest.contributes.views[container.id][0].id, 'branchReview.view');
  assert.equal(extensionManifest.contributes.views[container.id][0].type, 'webview');
  const elements = new Map();
  function element(id) {
    return {
      id, value: '', disabled: false, hidden: false, textContent: '', className: '', children: [], dataset: {},
      listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; },
      setAttribute(name, value) { this[name] = value; },
      getAttribute(name) { return this[name]; },
      replaceChildren() { this.children = []; this.firstChild = undefined; },
      appendChild(child) { this.children.push(child); if (!this.firstChild) this.firstChild = child; },
      focus() {}
    };
  }
  for (const id of [
    'baseline', 'target', 'baselineBranches', 'targetBranches', 'download',
    'clear', 'refresh', 'chooseBranches', 'cancel', 'project', 'reviewSummary', 'status',
    'modalStatus', 'modalTitle', 'analysisTab', 'resultsTab', 'branchesTab', 'analysisPanel', 'resultsPanel', 'branchesPanel',
    'reviewTabs', 'reviewDetails', 'changedFiles', 'noReview',
    'selectionModal', 'form', 'analysisModelInput', 'selectAnalysisModel', 'analysisModelDialog',
    'analysisModelSearch', 'analysisModelList', 'analysisModelDialogStatus', 'cancelAnalysisModel', 'confirmAnalysisModel',
    'analysisProfile', 'analysisGuide', 'analyze', 'resetGuide', 'analysisStatus', 'analysisResults', 'analysisProgressDialog', 'analysisProgressMessage', 'analysisProgressSteps', 'cancelAnalysisDialog', 'closeAnalysisDialog', 'analysisActions'
  ]) {
    elements.set(id, element(id));
  }
  elements.get('selectionModal').hidden = true;
  elements.get('reviewSummary').hidden = true;
  elements.get('noReview').hidden = false;
  elements.get('cancel').hidden = true;
  const outbound = [];
  const globalStateValues = {};
  let languageModels = [];
  let hostListener;
  let webviewListener;
  let editorListener;
  let repositoryOpenListener;
  let repositoryListenerReady;
  const repositoryListenerRegistered = new Promise(resolve => {
    repositoryListenerReady = resolve;
  });
  let nextMessage;
  let initialized;
  const init = new Promise(resolve => { initialized = resolve; });
  const webview = {
    onDidReceiveMessage(callback) { hostListener = callback; return { dispose() {} }; },
    postMessage(message) {
      webviewListener({ data: message });
      if (message.type === 'init' || message.type === 'initError') initialized(message);
      if (nextMessage && nextMessage.type === message.type) {
        nextMessage.resolve(message);
        nextMessage = undefined;
      }
      return Promise.resolve(true);
    }
  };
  let viewDisposed;
  const view = {
    webview,
    visible: true,
    onDidDispose(callback) { viewDisposed = callback; return { dispose() {} }; },
    onDidChangeVisibility() { return { dispose() {} }; }
  };
  const watcherEvents = {};
  const watcher = {
    onDidCreate(callback) { watcherEvents.create = callback; },
    onDidChange(callback) { watcherEvents.change = callback; },
    onDidDelete(callback) { watcherEvents.delete = callback; },
    dispose() {}
  };
  let command;
  let focusCount = 0;
  let warningChoice;
  const warnings = [];
  const repositories = [
    { rootUri: { fsPath: repo }, state: { HEAD: { name: 'main' } } },
    { rootUri: { fsPath: seed }, state: { HEAD: { name: 'feature/not-fetched' } } }
  ];
  const vscode = {
    extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({
      repositories,
      onDidOpenRepository(callback) {
        repositoryOpenListener = callback;
        repositoryListenerReady();
        return { dispose() {} };
      }
    }) } }) },
    window: {
      activeTextEditor: { document: { uri: { fsPath: path.join(repo, 'file.txt') } } },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showErrorMessage() {},
      showInformationMessage() {},
      showWarningMessage(message, options, ...choices) {
        warnings.push({ message, options, choices });
        return Promise.resolve(warningChoice);
      },
      registerWebviewViewProvider(id, provider, options) {
        assert.equal(id, 'branchReview.view');
        assert.equal(options.webviewOptions.retainContextWhenHidden, true);
        viewProvider = provider;
        return { dispose() {} };
      },
      onDidChangeActiveTextEditor(callback) { editorListener = callback; return { dispose() {} }; }
    },
    workspace: { createFileSystemWatcher: () => watcher },
    lm: {
      selectChatModels: async () => languageModels,
      onDidChangeChatModels: () => ({ dispose() {} })
    },
    RelativePattern: class {
      constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    commands: {
      registerCommand(name, callback) { command = callback; return { dispose() {} }; },
      executeCommand(name) {
        assert.equal(name, 'branchReview.view.focus');
        if (focusCount++ === 0) viewProvider.resolveWebviewView(view, {}, {});
        return Promise.resolve();
      }
    }
  };
  let viewProvider;
  const originalLoad = Module._load;
  let extension;
  try {
    Module._load = function(request, ...args) {
      return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);
    };
    extension = require('../out/extension');
  } finally {
    Module._load = originalLoad;
  }
  extension.activate({
    subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} },
    globalState: {
      get(key, fallback) { return globalStateValues[key] ?? fallback; },
      async update(key, value) { globalStateValues[key] = value; }
    }
  });
  t.after(() => viewDisposed?.());
  await command();
  await command();
  assert.equal(focusCount, 2);
  repositories.length = 0;
  assert.match(webview.html, /<select id="baselineBranches"/);
  assert.match(webview.html, /<select id="targetBranches"/);
  assert.match(webview.html, /<button id="analysisTab"[^>]*>Analysis<\/button>/);
  assert.ok(webview.html.indexOf('id="analysisTab"') < webview.html.indexOf('id="resultsTab"'));
  assert.ok(webview.html.indexOf('id="resultsTab"') < webview.html.indexOf('id="branchesTab"'));
  assert.match(webview.html, /<section id="resultsPanel"[^>]*hidden>/);
  assert.ok(!webview.html.includes('id="analysisResults"') || webview.html.indexOf('id="analysisResults"') > webview.html.indexOf('id="resultsPanel"'));
  assert.ok(webview.html.indexOf('id="project"') < webview.html.indexOf('id="reviewSummary"'));
  assert.ok(webview.html.indexOf('id="reviewSummary"') < webview.html.indexOf('id="reviewActions"'));
  assert.ok(webview.html.indexOf('id="reviewActions"') < webview.html.indexOf('id="reviewTabs"'));
  const script = webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage(message) {
      outbound.push(message);
      if (message.type === 'ready' || message.type === 'refresh') hostListener(message);
    } }),
    document: {
      getElementById: id => elements.get(id),
      createElement: tag => element(tag)
    },
    window: { addEventListener(type, callback) { webviewListener = callback; } }
  });
  const initialMessage = await init;
  assert.equal(initialMessage.type, 'initError');
  repositories.push(
    { rootUri: { fsPath: repo }, state: { HEAD: { name: 'main' } } },
    { rootUri: { fsPath: seed }, state: { HEAD: { name: 'feature/not-fetched' } } }
  );
  await repositoryListenerRegistered;
  const startupInit = new Promise(resolve => { nextMessage = { type: 'init', resolve }; });
  repositoryOpenListener(repositories[0]);
  const message = await startupInit;
  assert.equal(message.type, 'init');
  assert.equal(elements.get('project').textContent, 'Project: repo');
  assert.equal(elements.get('project').title, repo);
  assert.equal(elements.get('modalTitle').textContent, 'Choose branches — repo');
  assert.equal(elements.get('selectionModal').hidden, false);
  assert.equal(elements.get('cancel').hidden, true);
  const externalSync = new Promise(resolve => { nextMessage = { type: 'reviewState', resolve }; });
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});
  watcherEvents.change();
  await externalSync;
  languageModels = [
    { id: 'frequent', name: 'Frequent Model', vendor: 'vendor' },
    { id: 'slow', name: 'Slow Model', vendor: 'vendor' },
    { id: 'unused', name: 'Unused Model', vendor: 'vendor' }
  ];
  webviewListener({ data: {
    type: 'analysisState',
    models: [
      { id: 'frequent', name: 'Frequent Model', vendor: 'vendor', usage: 5 },
      { id: 'slow', name: 'Slow Model', vendor: 'vendor', usage: 1 },
      { id: 'unused', name: 'Unused Model', vendor: 'vendor', usage: 0 }
    ],
    selectedModelId: 'slow',
    profiles: [],
    results: []
  } });
  assert.equal(elements.get('analysisModelInput').value, 'Slow Model (vendor)');
  assert.equal(elements.get('analysisModelInput').dataset.modelId, 'slow');
  elements.get('selectAnalysisModel').listeners.click();
  assert.equal(elements.get('analysisModelDialog').hidden, false);
  elements.get('analysisModelSearch').value = 'frequent';
  elements.get('analysisModelSearch').listeners.input();
  assert.deepEqual(elements.get('analysisModelList').children.map(item => item.firstChild.textContent), ['Frequent Model (vendor)']);
  elements.get('analysisModelList').children[0].firstChild.listeners.click();
  assert.equal(elements.get('confirmAnalysisModel').disabled, false);
  elements.get('confirmAnalysisModel').listeners.click();
  assert.equal(elements.get('analysisModelDialog').hidden, true);
  assert.equal(elements.get('analysisModelInput').value, 'Frequent Model (vendor)');
  assert.equal(elements.get('analysisModelInput').dataset.modelId, 'frequent');
  assert.ok(outbound.some(message => message.type === 'selectAnalysisModel' && message.modelId === 'frequent'));
  hostListener({ type: 'selectAnalysisModel', modelId: 'frequent' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(globalStateValues['branchReview.analysis.modelId'], 'frequent');
  hostListener({ type: 'selectAnalysisModel', modelId: 'missing' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(globalStateValues['branchReview.analysis.modelId'], 'frequent');
  assert.equal(elements.get('selectionModal').hidden, true);
  assert.equal(elements.get('reviewSummary').hidden, false);
  assert.ok(elements.get('reviewSummary').textContent.includes('origin/feature/not-fetched'));
  assert.ok(elements.get('reviewDetails').textContent.includes('Changed files:'));
  elements.get('chooseBranches').listeners.click();
  assert.equal(elements.get('selectionModal').hidden, false);
  assert.equal(elements.get('cancel').hidden, false);
  elements.get('cancel').listeners.click();
  assert.equal(elements.get('selectionModal').hidden, true);
  for (const id of ['baselineBranches', 'targetBranches']) {
    assert.ok(elements.get(id).children.some(option => option.value === 'upstream/develop'));
    assert.ok(elements.get(id).children.some(option => option.value === 'main'));
  }
  assert.equal(elements.get('baseline').value, 'origin/develop');
  assert.equal(elements.get('target').value, 'origin/main');
  const manyBranches = Array.from({ length: 350 }, (_, i) => `origin/feature-${i}`);
  webviewListener({ data: { ...message, branches: manyBranches } });
  for (const id of ['baselineBranches', 'targetBranches']) {
    assert.deepEqual(elements.get(id).children.slice(1).map(option => option.value), manyBranches);
  }
  webviewListener({ data: message });
  elements.get('baselineBranches').value = 'upstream/develop';
  elements.get('baselineBranches').listeners.change();
  assert.equal(elements.get('baseline').value, 'upstream/develop');
  assert.equal(elements.get('baselineBranches').value, '');
  elements.get('targetBranches').value = 'upstream/feature/not-fetched';
  elements.get('targetBranches').listeners.change();
  assert.equal(elements.get('target').value, 'upstream/feature/not-fetched');
  elements.get('baseline').value = 'custom/base';
  elements.get('baseline').listeners.input();
  elements.get('target').value = 'custom/target';
  elements.get('target').listeners.input();
  webviewListener({ data: message });
  assert.equal(elements.get('baseline').value, 'custom/base');
  assert.equal(elements.get('target').value, 'custom/target');
  assert.equal(elements.get('download').disabled, false);

  git(seed, 'branch', 'new-remote-branch');
  git(seed, 'push', 'origin', 'new-remote-branch');
  git(seed, 'push', 'origin', '--delete', 'develop');
  const refreshed = new Promise(resolve => { nextMessage = { type: 'refreshed', resolve }; });
  elements.get('refresh').listeners.click();
  await refreshed;
  await new Promise(resolve => setImmediate(resolve));
  for (const id of ['baselineBranches', 'targetBranches']) {
    assert.ok(elements.get(id).children.some(option => option.value === 'origin/new-remote-branch'));
    assert.ok(!elements.get(id).children.some(option => option.value === 'origin/develop'));
  }
  assert.equal(elements.get('baseline').value, 'custom/base');
  assert.equal(elements.get('target').value, 'custom/target');

  git(repo, 'remote', 'set-url', 'origin', path.join(repo, 'missing-remote'));
  const unavailable = new Promise(resolve => { nextMessage = { type: 'refreshed', resolve }; });
  elements.get('refresh').listeners.click();
  await unavailable;
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.get('status').textContent, /Unable to list branches on origin/);
  assert.ok(!elements.get('baselineBranches').children.some(option => option.value === 'origin/main'));
  assert.ok(elements.get('baselineBranches').children.some(option => option.value === 'main'));
  assert.equal(elements.get('baseline').value, 'custom/base');
  assert.equal(elements.get('target').value, 'custom/target');

  warningChoice = 'Use Local Data';
  const completedDownload = new Promise(resolve => { nextMessage = { type: 'done', resolve }; });
  hostListener({ type: 'download', baseline: 'main', target: 'upstream/feature/not-fetched' });
  await completedDownload;
  await new Promise(resolve => setImmediate(resolve));
  assert.match(warnings.at(-1).message, /could not fetch baseline branch "main"/);
  assert.equal(warnings.at(-1).options.modal, true);
  assert.match(warnings.at(-1).options.detail, /refs\/remotes\/origin\/main/);
  assert.deepEqual(warnings.at(-1).choices, ['Use Local Data']);
  const savedReview = await readBranchReview(repo);
  warningChoice = undefined;
  const cancelledDownload = new Promise(resolve => { nextMessage = { type: 'error', resolve }; });
  hostListener({ type: 'download', baseline: 'main', target: 'upstream/feature/not-fetched' });
  assert.match((await cancelledDownload).text, /Download cancelled/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await readBranchReview(repo), savedReview);

  elements.get('form').listeners.submit({ preventDefault() {} });
  assert.equal(outbound.at(-1).baseline, 'custom/base');
  assert.equal(outbound.at(-1).target, 'custom/target');
  elements.get('target').value = ' custom/base ';
  elements.get('target').listeners.input();
  assert.equal(elements.get('download').disabled, true);
  webviewListener({ data: { type: 'initError', text: 'Unable to list branches' } });
  elements.get('target').value = 'another/branch';
  elements.get('target').listeners.input();
  assert.equal(elements.get('download').disabled, false);
  assert.equal(elements.get('status').textContent, 'Unable to list branches');

  const switched = new Promise(resolve => { nextMessage = { type: 'init', resolve }; });
  editorListener({ document: { uri: { fsPath: path.join(seed, 'file.txt') } } });
  await switched;
  assert.equal(elements.get('project').textContent, 'Project: seed');
  assert.equal(elements.get('project').title, seed);
  assert.equal(elements.get('modalTitle').textContent, 'Choose branches — seed');
  assert.equal(elements.get('target').value, 'origin/feature/not-fetched');
  assert.notEqual(elements.get('baseline').value, 'custom/base');
});

test('analysis sends only profile-relevant changes and stores the report', async t => {
  const { repo, seed } = await fixture(t);
  await fs.mkdir(path.join(seed, 'src'), { recursive: true });
  await fs.writeFile(path.join(seed, 'src', 'user.service.ts'), 'export class UserService {}\n');
  git(seed, 'add', 'src');
  git(seed, 'commit', '-m', 'add service');
  git(seed, 'push', 'origin', 'feature/not-fetched');
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});

  const prompts = [];
  const progress = [];
  const meta = await runAnalysis({
    repoRoot: repo,
    profile: findAnalysisProfile('angular'),
    guide: 'Custom guide',
    guideCustomized: true,
    model: { id: 'fake', name: 'Fake model' },
    signal: new AbortController().signal,
    countTokens: async prompt => prompt.length,
    sendPrompt: async prompt => { prompts.push(prompt); return `Report ${prompts.length}`; },
    onProgress() {},
    onStep: (step, status) => progress.push({ step, status })
  });
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.ok(prompt.includes('src/user.service.ts'));
    assert.ok(!prompt.includes('file.txt'));
  }
  assert.ok(prompts[0].includes('Custom guide'));
  assert.ok(prompts[1].includes('Custom guide'));
  assert.ok(prompts[2].includes('Custom guide'));
  assert.ok(prompts[0].includes('summarizing'));
  assert.ok(prompts[1].includes('severity'));
  assert.ok(prompts[2].includes('code smells'));
  assert.equal(meta.relevantFiles, 1);
  assert.equal(meta.modelCalls, 3);
  assert.equal(meta.batches, 1);
  assert.deepEqual(progress.map(step => `${step.step}:${step.status}`), [
    'prepare:running', 'prepare:completed',
    'summary:running', 'summary:completed',
    'bugs:running', 'bugs:completed',
    'codeSmells:running', 'codeSmells:completed',
    'save:running', 'save:completed'
  ]);
  assert.deepEqual(meta.skippedFiles, []);

  const savedResults = await listAnalysisResults(repo);
  const saved = savedResults.find(result => result.id === meta.id);
  assert.ok(saved);
  assert.equal(saved.id, meta.id);
  assert.equal(path.dirname(meta.reportFile), meta.createdAt.replace(/[:.]/g, '-'));
  const resultDirectory = path.join(resultsRoot(repo), path.dirname(meta.reportFile));
  const savedFiles = await fs.readdir(resultDirectory);
  assert.ok(savedFiles.includes(`${meta.id}.json`));
  assert.equal(savedFiles.filter(name => name.endsWith('.md')).length, 3);
  for (const [index, kind] of ['summary', 'bugs', 'codeSmells'].entries()) {
    assert.match(await fs.readFile(path.join(resultsRoot(repo), meta.reportFiles[kind]), 'utf8'), new RegExp(`Report ${index + 1}`));
  }

  await assert.rejects(runAnalysis({
    repoRoot: repo,
    profile: findAnalysisProfile('java'),
    guide: 'guide',
    guideCustomized: false,
    model: { id: 'fake', name: 'Fake model' },
    signal: new AbortController().signal,
    countTokens: async prompt => prompt.length,
    sendPrompt: async () => 'unused',
    onProgress() {}
  }), /No changed files match the Java profile/);
});

test('cancelling an analysis stops before saving a report', async t => {
  const { repo, seed } = await fixture(t);
  await fs.mkdir(path.join(seed, 'src'), { recursive: true });
  await fs.writeFile(path.join(seed, 'src', 'app.component.ts'), 'export class App {}\n');
  git(seed, 'add', 'src');
  git(seed, 'commit', '-m', 'add component');
  git(seed, 'push', 'origin', 'feature/not-fetched');
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});

  const controller = new AbortController();
  await assert.rejects(runAnalysis({
    repoRoot: repo,
    profile: findAnalysisProfile('angular'),
    guide: 'guide',
    guideCustomized: false,
    model: { id: 'fake', name: 'Fake model' },
    signal: controller.signal,
    countTokens: async prompt => prompt.length,
    sendPrompt: async () => { controller.abort(); return 'partial'; },
    onProgress() {}
  }), /Analysis cancelled/);
  assert.deepEqual(await listAnalysisResults(repo), []);
});

test('analysis refuses changes that exceed the model input window without sending', async t => {
  const { repo, seed } = await fixture(t);
  await fs.mkdir(path.join(seed, 'src'), { recursive: true });
  await fs.writeFile(path.join(seed, 'src', 'big.component.ts'), `${'// change\n'.repeat(2000)}`);
  git(seed, 'add', 'src');
  git(seed, 'commit', '-m', 'add big component');
  git(seed, 'push', 'origin', 'feature/not-fetched');
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});

  let sent = 0;
  await assert.rejects(runAnalysis({
    repoRoot: repo,
    profile: findAnalysisProfile('angular'),
    guide: 'guide',
    guideCustomized: false,
    model: { id: 'small', name: 'Small model', maxInputTokens: 1000 },
    signal: new AbortController().signal,
    countTokens: async prompt => prompt.length,
    sendPrompt: async () => { sent++; return 'unused'; },
    onProgress() {}
  }), /too large for Small model in one request/);
  assert.equal(sent, 0);
});

test('analysis preserves hunk context and discloses incomplete coverage', async t => {
  const { repo } = await fixture(t);
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});
  const reviewDir = path.join(branchReviewRoot(repo), 'ai-review');
  const changesFile = path.join(reviewDir, 'changed-files.json');
  const manifestFile = path.join(reviewDir, 'manifest.json');
  const changes = JSON.parse(await fs.readFile(changesFile, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const original = changes.files[0];
  const patch = '@@ -1,6 +1,6 @@\n unchanged 1\n unchanged 2\n unchanged 3\n unchanged 4\n-old\n+new\n';
  await fs.writeFile(path.join(reviewDir, original.diffFile), patch);
  changes.files.push(
    { ...original, newPath: 'partial.txt', oldPath: 'partial.txt', diffTruncated: true },
    { ...original, newPath: 'binary.txt', oldPath: 'binary.txt', binary: true },
    { ...original, newPath: 'missing.txt', oldPath: 'missing.txt', diffFile: `files/${'0'.repeat(64)}.patch` },
    { ...original, newPath: 'omitted.txt', oldPath: 'omitted.txt', diffFile: undefined, diffTruncated: true }
  );
  manifest.summary.changedFiles = changes.files.length;
  await fs.writeFile(changesFile, JSON.stringify(changes));
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const prompts = [];
  const meta = await runAnalysis({
    repoRoot: repo, profile: findAnalysisProfile('general-purpose'), guide: 'guide', guideCustomized: false,
    model: { id: 'fake', name: 'Fake' }, signal: new AbortController().signal,
    countTokens: async prompt => prompt.length,
    sendPrompt: async prompt => { prompts.push(prompt); return 'result'; }, onProgress() {}
  });
  assert.ok(prompts.every(prompt => prompt.includes(patch)));
  assert.equal(meta.relevantFiles, 5);
  assert.equal(meta.analyzedFiles, 2);
  assert.deepEqual(meta.skippedFiles, ['binary.txt', 'missing.txt', 'omitted.txt']);
  assert.deepEqual(meta.partialFiles, ['partial.txt']);
  assert.deepEqual((await listAnalysisResults(repo))[0].partialFiles, ['partial.txt']);
  for (const file of Object.values(meta.reportFiles)) {
    const report = await fs.readFile(path.join(resultsRoot(repo), file), 'utf8');
    assert.match(report, /2 \(1 partial\)/);
    for (const name of ['partial.txt', 'binary.txt', 'missing.txt', 'omitted.txt']) assert.ok(report.includes(name));
  }
});

test('analysis counts every prompt before sending any model request', async t => {
  const { repo } = await fixture(t);
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});
  let counted = 0;
  let sent = 0;
  await assert.rejects(runAnalysis({
    repoRoot: repo, profile: findAnalysisProfile('general-purpose'), guide: '?!😀', guideCustomized: true,
    model: { id: 'fake', name: 'Fake', maxInputTokens: 10000 }, signal: new AbortController().signal,
    countTokens: async () => ++counted === 3 ? 5001 : 100,
    sendPrompt: async () => { sent++; return 'result'; }, onProgress() {}
  }), /5001 tokens/);
  assert.equal(counted, 3);
  assert.equal(sent, 0);
});

test('cancellation during staging and publishing removes all output', async t => {
  const { repo } = await fixture(t);
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});
  for (const phase of ['staging', 'publishing', 'metadata']) {
    const controller = new AbortController();
    const rename = fs.rename;
    fs.rename = async (source, destination) => {
      await rename(source, destination);
      if (phase === 'staging' && source.endsWith('.tmp') && destination.endsWith('.md')) controller.abort();
      if (phase === 'publishing' && source.includes('.tmp-') && source.endsWith('.md')) controller.abort();
      if (phase === 'metadata' && source.includes('.tmp-') && source.endsWith('.json')) controller.abort();
    };
    try {
      await assert.rejects(runAnalysis({
        repoRoot: repo, profile: findAnalysisProfile('general-purpose'), guide: 'guide', guideCustomized: false,
        model: { id: 'fake', name: 'Fake' }, signal: controller.signal,
        countTokens: async prompt => prompt.length, sendPrompt: async () => 'result', onProgress() {}
      }), /Analysis cancelled/);
    } finally {
      fs.rename = rename;
    }
    assert.deepEqual(await listAnalysisResults(repo), []);
    const folders = await fs.readdir(resultsRoot(repo));
    for (const folder of folders) assert.deepEqual(await fs.readdir(path.join(resultsRoot(repo), folder)), []);
  }
});

test('re-downloading the review keeps saved analysis results by default', async t => {
  const { repo } = await fixture(t);
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});
  const directory = path.join(branchReviewRoot(repo), 'results');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'saved.md'), 'report');
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});
  assert.equal(await fs.readFile(path.join(directory, 'saved.md'), 'utf8'), 'report');
});

test('re-downloading the review can delete saved analysis results when requested', async t => {
  const { repo } = await fixture(t);
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});
  const directory = path.join(branchReviewRoot(repo), 'results');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'saved.md'), 'report');
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {}, undefined, false);
  await assert.rejects(fs.access(directory), { code: 'ENOENT' });
});

test('analysis sends all relevant files in three focused calls and saves three reports', async t => {
  const { repo, seed } = await fixture(t);
  await fs.mkdir(path.join(seed, 'src'), { recursive: true });
  for (const name of ['a', 'b', 'c', 'd']) {
    await fs.writeFile(path.join(seed, 'src', `${name}.component.ts`), `// ${name}\n`);
  }
  git(seed, 'add', 'src');
  git(seed, 'commit', '-m', 'add components');
  git(seed, 'push', 'origin', 'feature/not-fetched');
  await rebuildBranchReview(repo, 'main', 'origin/feature/not-fetched', () => {});

  const prompts = [];
  const progress = [];
  const meta = await runAnalysis({
    repoRoot: repo,
    profile: findAnalysisProfile('angular'),
    guide: 'guide',
    guideCustomized: false,
    model: { id: 'fake', name: 'Fake model' },
    signal: new AbortController().signal,
    countTokens: async prompt => prompt.length,
    sendPrompt: async prompt => { prompts.push(prompt); return 'single response'; },
    onProgress: text => progress.push(text)
  });
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    for (const name of ['a', 'b', 'c', 'd']) {
      assert.ok(prompt.includes(`src/${name}.component.ts`));
    }
  }
  assert.equal(meta.batches, 1);
  assert.equal(meta.modelCalls, 3);
  assert.equal(meta.analyzedFiles, 4);
  assert.equal(progress.filter(message => message.includes('report (')).length, 3);
  for (const reportFile of Object.values(meta.reportFiles)) {
    assert.match(await fs.readFile(path.join(resultsRoot(repo), reportFile), 'utf8'), /single response/);
  }
});

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Module = require('node:module');
const { listBranches, downloadBranch } = require('../out/git');

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
  const snapshot = await downloadBranch(repo, 'main', 'baseline', () => {});
  assert.equal(await fs.readFile(path.join(snapshot.directory, 'file.txt'), 'utf8'), 'main\n');
});

test('webview initializes, shares branch suggestions, and accepts typed names', async t => {
  const { repo, seed } = await fixture(t);
  const elements = new Map();
  function element(id) {
    return {
      id, value: '', disabled: false, textContent: '', className: '', children: [],
      listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; },
      replaceChildren() { this.children = []; },
      appendChild(child) { this.children.push(child); }
    };
  }
  for (const id of ['baseline', 'target', 'baselineBranches', 'targetBranches', 'download', 'clear', 'refresh', 'project', 'status', 'form']) {
    elements.set(id, element(id));
  }
  const outbound = [];
  let hostListener;
  let webviewListener;
  let editorListener;
  let nextMessage;
  let initialized;
  const init = new Promise(resolve => { initialized = resolve; });
  const webview = {
    onDidReceiveMessage(callback) { hostListener = callback; },
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
  const panel = { webview, onDidDispose() {}, reveal() {}, dispose() {} };
  let command;
  const vscode = {
    extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({
      repositories: [
        { rootUri: { fsPath: repo }, state: { HEAD: { name: 'main' } } },
        { rootUri: { fsPath: seed }, state: { HEAD: { name: 'feature/not-fetched' } } }
      ]
    }) } }) },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createWebviewPanel: () => panel,
      onDidChangeActiveTextEditor(callback) { editorListener = callback; return { dispose() {} }; }
    },
    commands: { registerCommand(name, callback) { command = callback; return { dispose() {} }; } },
    ViewColumn: { Active: 1 }
  };
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
  extension.activate({ subscriptions: [] });
  t.after(() => extension.deactivate());
  await command();
  assert.match(webview.html, /<select id="baselineBranches"/);
  assert.match(webview.html, /<select id="targetBranches"/);
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
  const message = await init;
  assert.equal(message.type, 'init');
  assert.equal(elements.get('project').textContent, 'Project: repo');
  assert.equal(elements.get('project').title, repo);
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
  assert.equal(elements.get('target').value, 'origin/feature/not-fetched');
  assert.notEqual(elements.get('baseline').value, 'custom/base');
});

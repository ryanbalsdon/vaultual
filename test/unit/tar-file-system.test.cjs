const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { packTar, unpackTar } = require('modern-tar');
const { loadSource } = require('../load-source.cjs');
const { createVSCode } = require('../vscode.cjs');
const bytes = (text) => new TextEncoder().encode(text);
const text = (value) => new TextDecoder().decode(value);

async function setup(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'vaultual-provider-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, '测试 # archive.tar');
  await fs.writeFile(
    filename,
    await packTar([
      {
        header: { name: 'hello.txt', type: 'file', size: 3 },
        body: bytes('old'),
      },
    ]),
  );
  const vscode = createVSCode();
  const { TarFileSystem } = loadSource('tar-file-system', vscode);
  const provider = new TarFileSystem();
  t.after(() => provider.dispose());
  const root = await provider.mount(vscode.Uri.file(filename));
  return {
    directory,
    filename,
    vscode,
    TarFileSystem,
    provider,
    root,
    uri: (name) => root.with({ path: name }),
  };
}

test('provider mounts, edits, creates, renames, deletes, and emits committed changes', async (t) => {
  const { provider, root, uri, filename } = await setup(t);
  const events = [];
  provider.onDidChangeFile((batch) => events.push(...batch));
  assert.deepEqual(await provider.readDirectory(root), [['hello.txt', 1]]);
  assert.equal((await provider.stat(root)).type, 2);
  const content = await provider.readFile(uri('/hello.txt'));
  content[0] = 0;
  assert.equal(text(await provider.readFile(uri('/hello.txt'))), 'old');
  const before = await provider.stat(uri('/hello.txt'));
  await provider.writeFile(uri('/hello.txt'), bytes('new'), {
    create: false,
    overwrite: true,
  });
  const after = await provider.stat(uri('/hello.txt'));
  assert.ok(after.mtime > before.mtime);
  await provider.createDirectory(uri('/nested/sub'));
  await provider.writeFile(uri('/nested/sub/new.txt'), bytes('created'), {
    create: true,
    overwrite: false,
  });
  await provider.rename(uri('/nested'), uri('/moved'), { overwrite: false });
  await provider.delete(uri('/moved'), { recursive: true });
  const files = await unpackTar(await fs.readFile(filename));
  assert.equal(
    text(files.find(({ header }) => header.name === 'hello.txt').data),
    'new',
  );
  assert.ok(
    events.some((event) => event.type === 1 && event.uri.path === '/hello.txt'),
  );
  assert.ok(
    events.some(
      (event) => event.type === 2 && event.uri.path === '/nested/sub/new.txt',
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === 3 && event.uri.path === '/moved/sub/new.txt',
    ),
  );
});

test('roots survive provider recreation without extra workspace state', async (t) => {
  const { provider, TarFileSystem, root, uri, vscode, filename } =
    await setup(t);
  assert.equal(
    (await provider.mount(vscode.Uri.file(filename))).toString(),
    root.toString(),
  );
  await provider.writeFile(uri('/hello.txt'), bytes('restored'), {
    create: false,
    overwrite: true,
  });
  const reloaded = new TarFileSystem();
  t.after(() => reloaded.dispose());
  assert.equal(text(await reloaded.readFile(uri('/hello.txt'))), 'restored');
});

test('provider reports filesystem errors and no successful change event on a save conflict', async (t) => {
  const { provider, root, uri, filename, vscode } = await setup(t);
  const events = [];
  provider.onDidChangeFile((batch) => events.push(...batch));
  await assert.rejects(provider.readFile(root), { code: 'FileIsADirectory' });
  await assert.rejects(provider.readDirectory(uri('/hello.txt')), {
    code: 'FileNotADirectory',
  });
  await assert.rejects(provider.stat(uri('/missing')), {
    code: 'FileNotFound',
  });
  await assert.rejects(
    provider.rename(
      uri('/hello.txt'),
      vscode.Uri.from({ scheme: 'vaultual', authority: '00', path: '/target' }),
      { overwrite: false },
    ),
    { code: 'NoPermissions' },
  );
  events.length = 0;
  await fs.writeFile(filename, await packTar([]));
  await assert.rejects(
    provider.writeFile(uri('/hello.txt'), bytes('conflict'), {
      create: false,
      overwrite: true,
    }),
    { code: 'Unavailable' },
  );
  assert.equal(events.length, 0);
  assert.equal(text(await provider.readFile(uri('/hello.txt'))), 'old');
  provider.unmount(root);
  await assert.rejects(provider.readFile(uri('/hello.txt')), {
    code: 'FileNotFound',
  });
});

test('mount command appends a workspace root once and exposes the provider', async (t) => {
  const { vscode, filename } = await setup(t);
  const subscriptions = [];
  loadSource('extension', vscode).activate({ subscriptions });
  t.after(() => subscriptions.forEach((item) => item.dispose()));
  const command = vscode.registeredCommands.get('vaultual.mountArchive');
  await command(vscode.Uri.file(filename));
  await command(vscode.Uri.file(filename));
  assert.equal(vscode.workspace.workspaceFolders.length, 1);
  assert.equal(
    vscode.workspace.workspaceFolders[0].name,
    path.basename(filename) + ' (archive)',
  );
  assert.ok(vscode.registeredProviders.has('vaultual'));
  await command(); // Cancelled picker leaves the workspace unchanged.
  assert.equal(vscode.workspace.workspaceFolders.length, 1);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { gzip, gunzip } = require('node:zlib');
const { packTar, unpackTar } = require('modern-tar');
const {
  createMessage,
  decrypt,
  encrypt,
  enums,
  readMessage,
} = require('openpgp');
const { loadSource } = require('../load-source.cjs');
const { createVSCode } = require('../vscode.cjs');

const manifest = require('../../package.json');
function loadExtension(showInformationMessage) {
  const vscode = createVSCode();
  const commands = vscode.registeredCommands;
  const subscriptions = [];
  vscode.window.showInformationMessage = showInformationMessage;
  loadSource('extension', vscode).activate({ subscriptions });
  return { commands, subscriptions, vscode };
}

test('activation registers the command advertised in the manifest', () => {
  const { commands } = loadExtension(async () => undefined);
  assert.equal(commands.size, 2);
  assert.equal(commands.has('vaultual.helloWorld'), true);
  assert.equal(manifest.contributes.commands[0].command, 'vaultual.helloWorld');
});

test('hello-world shows the greeting only when invoked and awaits the result', async () => {
  const messages = [];
  let finishMessage;
  const { commands } = loadExtension((message) => {
    messages.push(message);
    return new Promise((resolve) => {
      finishMessage = resolve;
    });
  });

  assert.deepEqual(messages, []);
  let finished = false;
  const invocation = commands
    .get('vaultual.helloWorld')()
    .then(() => {
      finished = true;
    });
  await Promise.resolve();
  assert.deepEqual(messages, ['Hello from Vaultual!']);
  assert.equal(finished, false);
  finishMessage(undefined);
  await invocation;
  assert.equal(finished, true);
});

test('the command reports notification failures to its caller', async () => {
  const error = new Error('Notification failed');
  const { commands } = loadExtension(async () => {
    throw error;
  });
  await assert.rejects(commands.get('vaultual.helloWorld')(), error);
});

test('context disposal unregisters the command', () => {
  const { commands, subscriptions } = loadExtension(async () => undefined);
  assert.ok(subscriptions.length > 0);
  for (const subscription of subscriptions) subscription.dispose();
  assert.equal(commands.size, 0);
});

const archivePassword = 'vaultual fixture password';

async function encryptedFixture(t, name, { compressed, fixture }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultual-pgp-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, name);
  if (fixture) {
    await fs.copyFile(path.join(__dirname, '../fixtures', fixture), filename);
    return filename;
  }
  const tar = await packTar([
    { header: { name: 'hello.txt', type: 'file', size: 3 }, body: 'old' },
  ]);
  const binary = compressed ? await promisify(gzip)(tar) : tar;
  await fs.writeFile(
    filename,
    await encrypt({
      message: await createMessage({ binary }),
      passwords: [archivePassword],
      format: 'binary',
      config: { preferredCompressionAlgorithm: enums.compression.zlib },
    }),
  );
  return filename;
}

for (const [name, armored, compressed, fixture] of [
  ['example.tar.gpg', false, false],
  ['example.tar.gz.gpg', false, true],
  ['example.tgz.ASC', true, true, 'pax.tgz.asc'],
]) {
  test(`mounting and saving ${name} retains encryption and compression`, async (t) => {
    const filename = await encryptedFixture(t, name, { compressed, fixture });
    const { commands, vscode } = loadExtension();
    let prompts = 0;
    vscode.window.showInputBox = async ({ password, title }) => {
      assert.equal(password, true);
      assert.ok(title.includes(name));
      prompts++;
      return archivePassword;
    };
    const mount = commands.get('vaultual.mountArchive');
    const source = vscode.Uri.file(filename);
    await mount(source);
    await mount(source);
    assert.equal(prompts, 1);
    assert.equal(vscode.workspace.workspaceFolders.length, 1);

    const { uri: root } = vscode.workspace.workspaceFolders[0];
    const provider = vscode.registeredProviders.get(root.scheme);
    const entryName = fixture ? 'bin/run.sh' : 'hello.txt';
    const file = root.with({ path: `/${entryName}` });
    const original = fixture ? '#!/bin/sh\necho portable\n' : 'old';
    assert.equal(
      Buffer.from(await provider.readFile(file)).toString(),
      original,
    );
    await provider.writeFile(file, Buffer.from('new'), {
      create: false,
      overwrite: true,
    });

    const diskBytes = await fs.readFile(filename);
    const message = armored
      ? await readMessage({ armoredMessage: diskBytes.toString() })
      : await readMessage({ binaryMessage: diskBytes });
    const { data } = await decrypt({
      message,
      passwords: [archivePassword],
      format: 'binary',
    });
    assert.equal(data[0] === 0x1f && data[1] === 0x8b, compressed);
    const entries = await unpackTar(
      compressed ? await promisify(gunzip)(data) : data,
    );
    assert.equal(
      Buffer.from(
        entries.find(({ header }) => header.name === entryName).data,
      ).toString(),
      'new',
    );
    assert.equal(prompts, 1);

    provider.unmount(root);
    assert.equal(Buffer.from(await provider.readFile(file)).toString(), 'new');
    assert.equal(prompts, 2);
  });
}

test('cancelling or entering a wrong archive password leaves the backing file and workspace intact', async (t) => {
  const filename = await encryptedFixture(t, 'example.pgp', {});
  const original = await fs.readFile(filename);
  const { commands, vscode } = loadExtension();
  const passwords = [undefined, 'incorrect', archivePassword];
  const errors = [];
  vscode.window.showInputBox = async () => passwords.shift();
  vscode.window.showErrorMessage = async (message) => errors.push(message);
  t.mock.method(console, 'error', () => {});
  const mount = commands.get('vaultual.mountArchive');
  const source = vscode.Uri.file(filename);
  await mount(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(vscode.workspace.workspaceFolders, []);
  await mount(source);
  assert.match(errors[0], /could not decrypt.*check the password/i);
  assert.deepEqual(vscode.workspace.workspaceFolders, []);
  assert.deepEqual(await fs.readFile(filename), original);
  await mount(source);
  assert.equal(vscode.workspace.workspaceFolders.length, 1);
});

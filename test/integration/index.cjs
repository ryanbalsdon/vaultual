const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const fs = require('node:fs/promises');
const os = require('node:os');
const { packTar, unpackTar } = require('modern-tar');

function waitForFolder(predicate, action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      listener.dispose();
      reject(new Error('Workspace folder change timed out'));
    }, 10_000);
    const finish = (folder) => {
      if (folder) {
        clearTimeout(timeout);
        listener.dispose();
        resolve(folder);
      }
    };
    const listener = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      finish(event.added.find(predicate));
    });
    Promise.resolve()
      .then(action)
      .then(() => finish(vscode.workspace.workspaceFolders?.find(predicate)))
      .catch((error) => {
        clearTimeout(timeout);
        listener.dispose();
        reject(error);
      });
  });
}

exports.run = async function run() {
  const extensionPath = path.resolve(__dirname, '../..');
  const extension = vscode.extensions.all.find(
    (candidate) => path.resolve(candidate.extensionPath) === extensionPath,
  );
  assert.ok(extension, 'VS Code must discover the development extension');
  assert.ok(
    extension.packageJSON.contributes.commands.some(
      (command) => command.command === 'vaultual.helloWorld',
    ),
    'The manifest must contribute the hello-world command',
  );

  // Invoking the contribution must activate the extension automatically.
  // Dismiss the notification so the command can finish without user input.
  const dismissal = setInterval(() => {
    void vscode.commands.executeCommand('notifications.clearAll');
  }, 100);
  const timeout = setTimeout(() => {
    rejectTimeout(new Error('Hello-world command timed out after 10 seconds'));
  }, 10_000);
  let rejectTimeout;
  try {
    await Promise.race([
      vscode.commands.executeCommand('vaultual.helloWorld'),
      new Promise((_, reject) => {
        rejectTimeout = reject;
      }),
    ]);
    assert.equal(
      extension.isActive,
      true,
      'Command must activate the extension',
    );
    console.log('PASS: VS Code discovers, activates, and executes Vaultual');
    await testArchiveWorkspace();
  } finally {
    clearInterval(dismissal);
    clearTimeout(timeout);
  }
};

async function testArchiveWorkspace() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'vaultual-integration-'),
  );
  const filename = path.join(directory, 'sample archive.tar');
  let root;
  try {
    await fs.writeFile(
      filename,
      await packTar([
        { header: { name: 'hello.txt', type: 'file', size: 3 }, body: 'old' },
        {
          header: { name: 'unchanged.bin', type: 'file', size: 3 },
          body: new Uint8Array([0, 128, 255]),
        },
      ]),
    );
    const folder = await waitForFolder(
      (candidate) => candidate.uri.scheme === 'vaultual',
      async () => {
        await vscode.commands.executeCommand(
          'vaultual.mountArchive',
          vscode.Uri.file(filename),
        );
      },
    );
    root = folder.uri;
    const file = vscode.Uri.joinPath(root, 'hello.txt');
    const document = await vscode.workspace.openTextDocument(file);
    assert.equal(document.getText(), 'old');
    const edits = new vscode.WorkspaceEdit();
    edits.replace(
      file,
      new vscode.Range(document.positionAt(0), document.positionAt(3)),
      'saved by VS Code',
    );
    assert.equal(await vscode.workspace.applyEdit(edits), true);
    assert.equal(await document.save(), true);
    const written = await unpackTar(await fs.readFile(filename), {
      strict: true,
    });
    assert.equal(
      new TextDecoder().decode(
        written.find(({ header }) => header.name === 'hello.txt').data,
      ),
      'saved by VS Code',
    );
    assert.deepEqual(
      [...written.find(({ header }) => header.name === 'unchanged.bin').data],
      [0, 128, 255],
    );
    const subdirectory = vscode.Uri.joinPath(root, 'nested');
    await vscode.workspace.fs.createDirectory(subdirectory);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(subdirectory, 'new.txt'),
      new TextEncoder().encode('new'),
    );
    const moved = vscode.Uri.joinPath(root, 'moved');
    await vscode.workspace.fs.rename(subdirectory, moved);
    await vscode.workspace.fs.delete(moved, { recursive: true });
    await vscode.commands.executeCommand(
      'vaultual.mountArchive',
      vscode.Uri.file(filename),
    );
    assert.equal(
      vscode.workspace.workspaceFolders.filter(
        (candidate) => candidate.uri.toString() === root.toString(),
      ).length,
      1,
    );
    console.log(
      'PASS: archive workspace mounts, saves, preserves other entries, and supports filesystem operations',
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (root) {
      const folder = vscode.workspace.workspaceFolders?.find(
        (candidate) => candidate.uri.toString() === root.toString(),
      );
      if (folder) vscode.workspace.updateWorkspaceFolders(folder.index, 1);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

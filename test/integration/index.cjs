const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function run() {
  const extensionPath = path.resolve(__dirname, '../..');
  const extension = vscode.extensions.all.find(
    (candidate) => path.resolve(candidate.extensionPath) === extensionPath,
  );
  assert.ok(extension, 'VS Code must discover the development extension');
  assert.ok(
    (await vscode.commands.getCommands(true)).includes('vaultual.helloWorld'),
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
  } finally {
    clearInterval(dismissal);
    clearTimeout(timeout);
  }
};

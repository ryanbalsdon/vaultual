const assert = require('node:assert/strict');
const { test } = require('node:test');
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

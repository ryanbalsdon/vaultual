const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const manifest = require('../../package.json');
const bundle = fs.readFileSync(
  path.resolve(__dirname, '../..', manifest.main),
  'utf8',
);

function loadExtension(showInformationMessage) {
  const commands = new Map();
  const subscriptions = [];
  const module = { exports: {} };
  const vscode = {
    commands: {
      registerCommand(id, handler) {
        assert.equal(commands.has(id), false, 'Command registered twice');
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
    },
    window: { showInformationMessage },
  };

  vm.runInNewContext(bundle, {
    module,
    exports: module.exports,
    require(id) {
      assert.equal(id, 'vscode');
      return vscode;
    },
  });

  module.exports.activate({ subscriptions });
  return { commands, subscriptions };
}

test('activation registers the command advertised in the manifest', () => {
  const { commands } = loadExtension(async () => undefined);
  assert.equal(commands.size, 1);
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
  assert.equal(subscriptions.length, 1);
  for (const subscription of subscriptions) subscription.dispose();
  assert.equal(commands.size, 0);
});

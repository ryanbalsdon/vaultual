import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('vaultual.helloWorld', async () => {
      await vscode.window.showInformationMessage('Hello from Vaultual!');
    }),
  );
}

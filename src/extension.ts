import * as vscode from 'vscode';
import { posix } from 'node:path';
import { ArchiveUnlockCancelled } from './archive-encryption';
import { TAR_SCHEME, TarFileSystem } from './tar-file-system';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TarFileSystem();
  context.subscriptions.push(
    provider,
    vscode.workspace.registerFileSystemProvider(TAR_SCHEME, provider, {
      isCaseSensitive: true,
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.removed) {
        if (folder.uri.scheme === TAR_SCHEME) provider.unmount(folder.uri);
      }
    }),
    vscode.commands.registerCommand(
      'vaultual.mountArchive',
      async (resource?: vscode.Uri) => {
        try {
          const source =
            resource ??
            (
              await vscode.window.showOpenDialog({
                canSelectMany: false,
                canSelectFolders: false,
                filters: {
                  'Tar archives': ['tar', 'tar.gz', 'tgz', 'gpg', 'pgp', 'asc'],
                },
                openLabel: 'Mount Archive',
              })
            )?.[0];
          if (!source) return;
          const root = await provider.mount(source);
          const folders = vscode.workspace.workspaceFolders ?? [];
          if (
            folders.some((folder) => folder.uri.toString() === root.toString())
          )
            return;
          if (
            !vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
              uri: root,
              name: `${posix.basename(source.path)} (archive)`,
            })
          ) {
            provider.unmount(root);
            throw new Error(
              'VS Code could not add the archive workspace folder.',
            );
          }
        } catch (error) {
          if (error instanceof ArchiveUnlockCancelled) return;
          console.error('Vaultual: cannot mount archive', error);
          await vscode.window.showErrorMessage(
            `Cannot mount archive: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
  );
}

import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { ArchiveError, archivePath, type Archive, type Entry } from './archive';
import {
  ArchiveUnlockCancelled,
  ENCRYPTED_ARCHIVE_SUFFIX,
  unlockArchive,
} from './archive-encryption';
import { ArchiveStore, DiskArchiveStorage } from './archive-store';

export const TAR_SCHEME = 'vaultual';

interface Mount {
  store: Promise<ArchiveStore>;
  cancelled: boolean;
}

// Bridges VS Code's virtual workspace folders to the archive store that serves
// reads from the current tree and persists edits to the backing file.
export class TarFileSystem
  implements vscode.FileSystemProvider, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  /** VS Code listens for committed changes to refresh its views. */
  readonly onDidChangeFile = this.changes.event;
  private readonly mounts = new Map<string, Mount>();

  /** The Mount Archive command uses this to open the archive before adding its workspace folder. */
  async mount(source: vscode.Uri): Promise<vscode.Uri> {
    this.validateMountSource(source);
    const root = await this.mountRoot(source);
    if (this.mounts.get(root.authority)?.cancelled) this.unmount(root);
    await this.store(root);
    return root;
  }

  /** Releases the cached tree when VS Code removes the archive's workspace folder. */
  unmount(root: vscode.Uri): void {
    this.mounts.delete(root.authority);
  }

  /** VS Code disposes the provider when the extension deactivates. */
  dispose(): void {
    this.mounts.clear();
    this.changes.dispose();
  }

  /** Satisfies VS Code's watch requests for virtual paths. */
  watch(): vscode.Disposable {
    // Virtual edits emit events after persistence, so there is no per-path watcher to release.
    return new vscode.Disposable(() => {});
  }

  /** Supplies VS Code with the entry type, timestamps, and size. */
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.translate(async () => this.fileStat(await this.entry(uri)));
  }

  /** Lists a folder's immediate children when VS Code browses the workspace. */
  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.translate(async () => {
      const archive = (await this.store(uri)).archive;
      return archive
        .children(this.path(uri))
        .map(([name, entry]) => [posix.basename(name), this.fileType(entry)]);
    });
  }

  /** Supplies the committed file bytes when VS Code opens or reloads a document. */
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.translate(async () => {
      const entry = await this.entry(uri);
      if (entry.header.type === 'directory')
        throw vscode.FileSystemError.FileIsADirectory(uri);

      // Give callers a copy so they cannot mutate bytes shared by the live tree and drafts.
      return entry.data.slice();
    });
  }

  /** Persists file creation or edits from VS Code, including editor saves. */
  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    // Do not retain a caller-owned buffer while another save is in flight.
    const bytes = content.slice();
    return this.change(uri, (archive) => {
      archive.write(this.path(uri), bytes, options.create, options.overwrite);
    });
  }

  /** Persists a VS Code folder creation request, including missing parent folders. */
  createDirectory(uri: vscode.Uri): Promise<void> {
    return this.change(uri, (archive) => archive.mkdir(this.path(uri)));
  }

  /** Applies VS Code's recursive delete option and persists the resulting tree. */
  delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    return this.change(uri, (archive) =>
      archive.delete(this.path(uri), options.recursive),
    );
  }

  /** Persists a VS Code rename or move within the same mounted archive. */
  async rename(
    from: vscode.Uri,
    to: vscode.Uri,
    options: { overwrite: boolean },
  ): Promise<void> {
    this.requireSameMount(from, to);
    return this.change(from, (archive) =>
      archive.rename(this.path(from), this.path(to), options.overwrite),
    );
  }

  private validateMountSource(source: vscode.Uri): void {
    // The backing file must be accessible to the extension host. The suffix
    // matches the mount command's file picker. The decoder checks the contents.
    if (source.scheme !== 'file') {
      throw new Error('Select an archive on the extension host filesystem.');
    }
    if (
      !/\.(tar|tar\.gz|tgz)$/i.test(source.path) &&
      !ENCRYPTED_ARCHIVE_SUFFIX.test(source.path)
    ) {
      throw new Error(
        'Select a tar, gzip-compressed tar, or OpenPGP-encrypted tar archive.',
      );
    }
  }

  private async mountRoot(source: vscode.Uri): Promise<vscode.Uri> {
    // Resolve symlinks so aliases of the same backing file share a mount.
    const canonical = vscode.Uri.file(await realpath(source.fsPath));

    // VS Code can restore the workspace folder on restart because the root URI
    // carries the archive's backing URI.
    return vscode.Uri.from({
      scheme: TAR_SCHEME,
      authority: Buffer.from(canonical.toString()).toString('hex'),
      path: '/',
    });
  }

  private async entry(uri: vscode.Uri): Promise<Entry> {
    return (await this.store(uri)).archive.get(this.path(uri));
  }

  private fileStat(entry: Entry): vscode.FileStat {
    return {
      type: this.fileType(entry),
      ctime: entry.ctime,
      mtime: entry.mtime,
      size: entry.data.byteLength,
    };
  }

  private fileType(entry: Entry): vscode.FileType {
    return entry.header.type === 'directory'
      ? vscode.FileType.Directory
      : vscode.FileType.File;
  }

  private requireSameMount(from: vscode.Uri, to: vscode.Uri): void {
    // Rename is a single store update. Crossing mounts would require two saves.
    if (from.scheme !== to.scheme || from.authority !== to.authority) {
      throw vscode.FileSystemError.NoPermissions(
        'Cannot rename between archives.',
      );
    }
  }

  private path(uri: vscode.Uri): string {
    // Remove the URI's leading slash so the path can use the same rules as tar names.
    if (!uri.path.startsWith('/'))
      throw vscode.FileSystemError.NoPermissions(uri);
    return archivePath(uri.path.slice(1));
  }

  private async store(uri: vscode.Uri): Promise<ArchiveStore> {
    // Restored workspace URIs can reach the provider before the mount command runs.
    // Check that the authority contains complete hex bytes before decoding it.
    if (
      uri.scheme !== TAR_SCHEME ||
      !/^(?:[a-f0-9]{2})+$/.test(uri.authority)
    ) {
      throw vscode.FileSystemError.Unavailable(
        'Invalid archive workspace URI.',
      );
    }
    let mount = this.mounts.get(uri.authority);
    if (!mount) {
      const source = this.backingFile(uri.authority);
      const name = posix.basename(source.path);
      const store = ArchiveStore.open(
        new DiskArchiveStorage(source.fsPath),
        (bytes) =>
          unlockArchive(bytes, name, () =>
            vscode.window.showInputBox({
              title: `Unlock ${name}`,
              prompt: 'Enter the OpenPGP archive password',
              password: true,
              ignoreFocusOut: true,
            }),
          ),
      );
      const opening = { store, cancelled: false };
      // Share an in-progress open and let later requests retry if it fails.
      this.mounts.set(uri.authority, opening);
      mount = opening;
      void store.catch((error: unknown) => {
        // A cancelled unlock stays closed until explicitly mounted again.
        if (error instanceof ArchiveUnlockCancelled) opening.cancelled = true;
        else if (this.mounts.get(uri.authority) === opening) this.unmount(uri);
      });
    }
    return mount.store;
  }

  private backingFile(authority: string): vscode.Uri {
    // Recover the backing file from the workspace URI even when the cache is empty.
    const source = vscode.Uri.parse(
      Buffer.from(authority, 'hex').toString('utf8'),
    );
    if (source.scheme !== 'file')
      throw vscode.FileSystemError.NoPermissions(source);
    return source;
  }

  private async change(
    uri: vscode.Uri,
    mutation: (archive: Archive) => void,
  ): Promise<void> {
    return this.translate(async () => {
      const store = await this.store(uri);
      let before: Archive | undefined;
      await store.update((draft) => {
        // Capture the live tree after earlier queued edits have finished.
        before = store.archive;
        mutation(draft);
      });

      // Notify VS Code after the save succeeds so failed drafts remain invisible.
      const events = this.fileChanges(uri, before, store.archive);
      if (events.length) this.changes.fire(events);
    });
  }

  private fileChanges(
    uri: vscode.Uri,
    before: Archive | undefined,
    after: Archive,
  ): vscode.FileChangeEvent[] {
    const events: vscode.FileChangeEvent[] = [];
    // Drafts share unchanged entries, so identity is enough to detect edits.
    for (const [name, entry] of after.entries) {
      const old = before?.entries.get(name);
      if (old === entry) continue;
      events.push({
        uri: uri.with({ path: name }),
        type: old
          ? vscode.FileChangeType.Changed
          : vscode.FileChangeType.Created,
      });
    }

    // Removed paths only exist in the old tree. A rename also removes the old path.
    for (const name of before?.entries.keys() ?? []) {
      if (!after.entries.has(name)) {
        events.push({
          uri: uri.with({ path: name }),
          type: vscode.FileChangeType.Deleted,
        });
      }
    }
    return events;
  }

  private async translate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // Preserve filesystem error codes so VS Code can distinguish common failures.
      if (error instanceof vscode.FileSystemError) throw error;
      if (error instanceof ArchiveError)
        throw vscode.FileSystemError[error.code](error.message);
      throw vscode.FileSystemError.Unavailable(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

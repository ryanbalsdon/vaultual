import { posix } from 'node:path';
import { ArchiveCodec } from './archive-codec';
import {
  ArchiveError,
  buildArchiveTree,
  createEmptyTree,
  ensureDirectory,
  getEntry,
  touchEntry,
  type Entry,
} from './archive-tree';

export { MAX_ARCHIVE_BYTES } from './archive-codec';
export { ArchiveError, archivePath, type Entry } from './archive-tree';

// TarFileSystem serves VS Code reads from the live archive. ArchiveStore stages
// edits in a draft and publishes it after the backing file is replaced.
export class Archive {
  /** Starts with a decoded tree, a draft snapshot, or an empty root. */
  constructor(
    public readonly entries = createEmptyTree(),
    public readonly compressed = false,
  ) {}

  /** ArchiveStore uses this when a mount first opens its backing file. */
  static async decode(bytes: Uint8Array): Promise<Archive> {
    const { entries, compressed } = await ArchiveCodec.unpackArchive(bytes);
    return new Archive(buildArchiveTree(entries), compressed);
  }

  /** ArchiveStore serializes the edited draft before replacing the backing file. */
  async encode(): Promise<Uint8Array> {
    return ArchiveCodec.packArchive([...this.entries], this.compressed);
  }

  /** Starts a staged edit. Entries and file bytes are shared until replaced. */
  fork(): Archive {
    return new Archive(new Map(this.entries), this.compressed);
  }

  /** Serves VS Code metadata and file-content requests through the provider. */
  get(name: string): Entry {
    return getEntry(this.entries, name);
  }

  /** Supplies the direct children when VS Code lists or expands a folder. */
  children(name: string): [string, Entry][] {
    this.requireDirectory(name);

    // The root is its own dirname, so exclude the directory itself from the listing.
    return [...this.entries].filter(
      ([key]) => key !== name && posix.dirname(key) === name,
    );
  }

  /** Handles VS Code folder creation on the draft, including missing parents. */
  mkdir(name: string): void {
    ensureDirectory(this.entries, name);
  }

  /** Stages bytes from VS Code's writeFile request, such as an editor save. */
  write(
    name: string,
    data: Uint8Array,
    create: boolean,
    overwrite: boolean,
  ): void {
    const previous = this.entries.get(name);
    this.validateWrite(name, previous, create, overwrite);
    const parent = posix.dirname(name);
    this.requireDirectory(parent);
    this.entries.set(name, Archive.createFileEntry(name, data, previous));
    touchEntry(this.entries, parent);
  }

  /** Stages a VS Code delete request with the requested recursion policy. */
  delete(name: string, recursive: boolean): void {
    this.validateDelete(name, recursive);
    this.deleteSubtree(name);
    touchEntry(this.entries, posix.dirname(name));
  }

  /** Stages a rename or move within a single mounted archive. */
  rename(from: string, to: string, overwrite: boolean): void {
    const source = this.get(from);
    if (from === to) return;

    this.prepareRenameTarget(from, to, source, overwrite);
    this.moveSubtree(from, to);
    touchEntry(this.entries, posix.dirname(from));
    touchEntry(this.entries, posix.dirname(to));
  }

  private requireDirectory(name: string): void {
    // The provider reports distinct errors for a missing path and a file at that path.
    if (this.get(name).header.type !== 'directory') {
      throw new ArchiveError('FileNotADirectory', name);
    }
  }

  private validateWrite(
    name: string,
    previous: Entry | undefined,
    create: boolean,
    overwrite: boolean,
  ): void {
    // Preserve the provider's create and overwrite contract without replacing a directory.
    if (previous?.header.type === 'directory') {
      throw new ArchiveError('FileIsADirectory', name);
    }
    if (previous && !overwrite) throw new ArchiveError('FileExists', name);
    if (!previous && !create) throw new ArchiveError('FileNotFound', name);
  }

  private static createFileEntry(
    name: string,
    data: Uint8Array,
    previous: Entry | undefined,
  ): Entry {
    // Each edit needs a distinct modification time, even within the same millisecond.
    const now = Math.max(Date.now(), (previous?.mtime ?? 0) + 1);

    // Preserve existing metadata and give the draft its own copy of the new bytes.
    return {
      header: {
        ...(previous?.header ?? { mode: 0o644 }),
        name,
        type: 'file',
        size: data.byteLength,
        mtime: new Date(now),
      },
      data: data.slice(),
      ctime: previous?.ctime ?? now,
      mtime: now,
    };
  }

  private validateDelete(name: string, recursive: boolean): void {
    // The root represents the mounted workspace folder and must exist for the mount's lifetime.
    if (name === '/')
      throw new ArchiveError('NoPermissions', 'Cannot delete root');
    const entry = this.get(name);

    // A non-recursive request may remove an empty directory only.
    if (
      entry.header.type === 'directory' &&
      !recursive &&
      this.children(name).length
    ) {
      throw new ArchiveError(
        'NoPermissions',
        `Directory is not empty: ${name}`,
      );
    }
  }

  private deleteSubtree(name: string): void {
    // Include the separator so deleting /docs leaves /docs-old intact.
    for (const key of this.entries.keys()) {
      if (key === name || key.startsWith(name + '/')) this.entries.delete(key);
    }
  }

  private prepareRenameTarget(
    from: string,
    to: string,
    source: Entry,
    overwrite: boolean,
  ): void {
    // Keep the mount root fixed and prevent a subtree from becoming its own ancestor.
    if (from === '/' || to === '/' || to.startsWith(from + '/')) {
      throw new ArchiveError(
        'NoPermissions',
        'Cannot move root or a directory into itself',
      );
    }
    this.requireDirectory(posix.dirname(to));
    const target = this.entries.get(to);

    // Match the source type and use non-recursive removal to protect destination contents.
    if (target) {
      if (!overwrite) throw new ArchiveError('FileExists', to);
      if (target.header.type !== source.header.type) {
        throw new ArchiveError(
          target.header.type === 'directory'
            ? 'FileIsADirectory'
            : 'FileNotADirectory',
          to,
        );
      }
      this.delete(to, false);
    }
  }

  private moveSubtree(from: string, to: string): void {
    // Iterate over a snapshot so newly inserted paths are never revisited during the move.
    for (const [key, value] of [...this.entries]) {
      if (key !== from && !key.startsWith(from + '/')) continue;
      const name = to + key.slice(from.length);

      // Update both the lookup key and stored path while retaining the entry's data.
      this.entries.delete(key);
      this.entries.set(name, { ...value, header: { ...value.header, name } });
    }
  }
}

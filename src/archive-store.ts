import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Archive, ArchiveError, MAX_ARCHIVE_BYTES } from './archive';

// The adapter keeps storage separate from the in-memory model and makes disk
// failures and concurrent saves testable without changing the real filesystem.
export interface ArchiveStorage {
  /** Loads the backing bytes for a mount or a pre-save conflict check. */
  read(): Promise<Uint8Array>;
  /** Replaces the backing bytes if they still match the store's last snapshot. */
  replace(expected: Uint8Array, bytes: Uint8Array): Promise<void>;
}

export class DiskArchiveStorage implements ArchiveStorage {
  /** The filesystem provider creates one disk adapter per mounted archive. */
  constructor(private readonly filename: string) {}

  /** Reads the archive when opening a mount and again before saving a draft. */
  async read(): Promise<Uint8Array> {
    const info = await fs.stat(this.filename);

    // The store loads the entire file, so check its type and size before reading.
    if (!info.isFile())
      throw new Error('The backing archive must be a regular file.');
    if (info.size > MAX_ARCHIVE_BYTES)
      throw new Error('Archive exceeds 256 MiB.');
    return fs.readFile(this.filename);
  }

  /** Writes a complete draft before making it the mounted archive's backing file. */
  async replace(expected: Uint8Array, bytes: Uint8Array): Promise<void> {
    // Stage the file beside the original so the final rename stays on one filesystem.
    const temporary = join(
      dirname(this.filename),
      `.vaultual-${randomUUID()}.tmp`,
    );
    try {
      const info = await fs.stat(this.filename);

      // Exclusive creation avoids overwriting an existing temporary file.
      const file = await fs.open(temporary, 'wx', info.mode & 0o777);
      try {
        // Restore any permission bits masked by the process umask and flush the draft.
        await file.writeFile(bytes);
        await file.chmod(info.mode & 0o777);
        await file.sync();
      } finally {
        await file.close();
      }

      // Compare bytes immediately before replacement. A conflicting save is
      // reported to VS Code, leaving its editor dirty and the live model intact.
      const current = await this.read();
      if (!Buffer.from(current).equals(expected)) {
        throw new ArchiveError(
          'Unavailable',
          'The archive changed on disk. Remove its workspace folder and mount it again before saving.',
        );
      }
      await fs.rename(temporary, this.filename);
    } finally {
      // Failed saves can leave a draft here. A successful rename consumed it.
      await fs.rm(temporary, { force: true });
    }
  }
}

export class ArchiveStore {
  private tail = Promise.resolve();

  private constructor(
    private readonly storage: ArchiveStorage,
    public archive: Archive,
    private baseline: Uint8Array,
  ) {}

  /** Loads the live tree when the provider first opens a new or restored mount. */
  static async open(storage: ArchiveStorage): Promise<ArchiveStore> {
    const bytes = await storage.read();

    // Keep the exact disk bytes as the baseline for the first conflict check.
    return new ArchiveStore(storage, await Archive.decode(bytes), bytes);
  }

  /** Persists a VS Code write, folder creation, deletion, or rename on this mount. */
  update(change: (draft: Archive) => void): Promise<void> {
    // Queue edits so each draft starts from the last successfully saved tree.
    const task = this.tail.then(async () => {
      const draft = this.archive.fork();
      change(draft);
      const bytes = await draft.encode();
      await this.storage.replace(this.baseline, bytes);

      // Publish only after persistence succeeds so reads and retries see a consistent snapshot.
      this.baseline = bytes;
      this.archive = draft;
    });

    // Keep the queue usable after a failure while returning the error to this caller.
    this.tail = task.catch(() => {});
    return task;
  }
}

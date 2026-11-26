import type { ParsedTarEntryWithData, TarHeader } from 'modern-tar';
import { posix } from 'node:path';
import { MAX_ENTRIES } from './archive-codec';

/** Gives Archive.decode a tree that VS Code can browse as soon as the mount opens. */
export function buildArchiveTree(
  entries: readonly ParsedTarEntryWithData[],
): Map<string, Entry> {
  // Reject an oversized entry list before allocating the tree.
  if (entries.length > MAX_ENTRIES)
    throw new Error('Too many archive entries.');
  const tree = createEmptyTree();
  const explicitEntries = new Map<string, Entry>();
  for (const { header, data } of entries) {
    const name = validateTarEntry(header);

    // Two explicit headers at one canonical path would make file lookup ambiguous.
    if (explicitEntries.has(name)) {
      throw new Error(`Duplicate archive entry: ${header.name}`);
    }
    ensureDirectory(tree, posix.dirname(name));
    const previous = tree.get(name);

    // An explicit directory may replace an inferred one, but a file cannot occupy it.
    if (previous && previous.header.type !== header.type) {
      throw new Error(`Conflicting archive entries: ${header.name}`);
    }

    // Tar exposes modification time. Use it for both timestamps on the initial VS Code stat.
    const mtime = header.mtime?.getTime() ?? 0;
    const entry = {
      header,
      data: data ?? new Uint8Array(),
      mtime,
      ctime: mtime,
    };
    tree.set(name, entry);
    explicitEntries.set(name, entry);
  }
  // Synthesizing missing ancestors must not alter timestamps of explicit
  // directory entries that happened to occur earlier in the archive.
  for (const [name, entry] of explicitEntries) tree.set(name, entry);

  // Directories inferred from file paths also count toward the in-memory entry limit.
  if (tree.size > MAX_ENTRIES) throw new Error('Too many archive entries.');
  return tree;
}

/** Seeds the virtual root, even when the tar has no root entry. */
export function createEmptyTree(): Map<string, Entry> {
  return new Map([['/', directory('/')]]);
}

/** Creates parents for both decoded entries and VS Code folder requests. */
export function ensureDirectory(tree: Map<string, Entry>, name: string): void {
  const entry = tree.get(name);

  // Existing directories satisfy the request. Files block creation at the same path.
  if (entry) {
    if (entry.header.type !== 'directory') {
      throw new ArchiveError('FileNotADirectory', name);
    }
    return;
  }

  // Add ancestors first so every entry is reachable from the mounted root.
  const parent = posix.dirname(name);
  ensureDirectory(tree, parent);
  tree.set(name, directory(name));
  touchEntry(tree, parent);
}

/** Records directory changes for both VS Code stats and the next archive save. */
export function touchEntry(tree: Map<string, Entry>, name: string): void {
  const previous = getEntry(tree, name);

  // Use a newer time even for rapid edits. Replacing the entry keeps shared drafts
  // isolated and lets the provider detect the change by comparing entry identities.
  const now = Math.max(Date.now(), previous.mtime + 1);
  tree.set(name, {
    ...previous,
    header: { ...previous.header, mtime: new Date(now) },
    mtime: now,
  });
}

/** Supplies required entries for reads and mutations with a provider-compatible error. */
export function getEntry(
  tree: ReadonlyMap<string, Entry>,
  name: string,
): Entry {
  const entry = tree.get(name);
  if (!entry) throw new ArchiveError('FileNotFound', name);
  return entry;
}

function validateTarEntry(header: TarHeader): string {
  // The mounted tree models only regular files and directories.
  if (header.type !== 'file' && header.type !== 'directory') {
    throw new Error(`Unsupported tar entry (${header.type}): ${header.name}`);
  }

  // PAX can flag a sparse file even when the decoded type says it is a regular file.
  if (Object.keys(header.pax ?? {}).some((key) => /sparse/i.test(key))) {
    throw new Error(`Sparse tar entries are not supported: ${header.name}`);
  }
  const name = archivePath(header.name);

  // A root header can supply directory metadata, but it cannot turn the mount into a file.
  if (name === '/' && header.type !== 'directory') {
    throw new Error('The archive root must be a directory.');
  }
  return name;
}

function directory(name: string): Entry {
  const now = Date.now();

  // Inferred and newly created directories need metadata for VS Code and tar output.
  return {
    header: {
      name,
      type: 'directory',
      size: 0,
      mode: 0o755,
      mtime: new Date(now),
    },
    data: new Uint8Array(),
    ctime: now,
    mtime: now,
  };
}

/** Gives decoded headers and VS Code URI lookups the same internal path keys. */
export function archivePath(name: string): string {
  // Keep names relative to this archive and reject ambiguous cross-platform spellings.
  if (
    name.includes('\\') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[a-z]:/i.test(name) ||
    name.split('/').includes('..')
  ) {
    throw new ArchiveError('NoPermissions', `Unsafe archive path: ${name}`);
  }

  // Fold empty and dot segments, then catch drive prefixes exposed by that cleanup.
  const parts = name.split('/').filter((part) => part && part !== '.');
  if (/^[a-z]:/i.test(parts[0] ?? '')) {
    throw new ArchiveError('NoPermissions', `Unsafe archive path: ${name}`);
  }
  return '/' + parts.join('/');
}

export interface Entry {
  readonly header: TarHeader;
  readonly data: Uint8Array;
  readonly ctime: number;
  readonly mtime: number;
}

export class ArchiveError extends Error {
  /** The filesystem provider translates these codes into VS Code errors. */
  constructor(
    public readonly code:
      | 'FileNotFound'
      | 'FileExists'
      | 'FileIsADirectory'
      | 'FileNotADirectory'
      | 'NoPermissions'
      | 'Unavailable',
    message: string,
  ) {
    super(message);
  }
}

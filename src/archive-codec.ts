import {
  packTar,
  unpackTar,
  type ParsedTarEntryWithData,
  type TarEntry,
  type TarHeader,
} from 'modern-tar';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { Entry } from './archive-tree';

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRIES = 100_000;

export class ArchiveCodec {
  /** Reads the backing bytes for Archive.decode and records the format to save back in. */
  static async unpackArchive(
    bytes: Uint8Array,
  ): Promise<{ entries: ParsedTarEntryWithData[]; compressed: boolean }> {
    // Bound the input before decoding because the mounted archive is held in memory.
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(
        'Archives larger than 256 MiB are not supported in memory.',
      );
    }

    // Identify gzip from the bytes and apply the same limit to decompressed output.
    const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const tar = compressed
      ? await decompress(bytes, { maxOutputLength: MAX_ARCHIVE_BYTES })
      : bytes;

    // Require whole tar blocks and room for the two end blocks before strict parsing.
    if (tar.byteLength < 1024 || tar.byteLength % 512 !== 0) {
      throw new Error('Invalid or truncated tar archive.');
    }
    const entries = await unpackTar(tar, { strict: true });
    return { entries, compressed };
  }

  /** Produces replacement bytes for the store when a staged edit is committed. */
  static async packArchive(
    entries: ReadonlyArray<readonly [name: string, entry: Entry]>,
    compressed: boolean,
  ): Promise<Uint8Array> {
    // Check the draft's entry count before allocating the tar buffer.
    if (entries.length > MAX_ENTRIES)
      throw new Error('Too many archive entries.');
    const tar = await packTar(
      entries.map(([name, entry]) => ArchiveCodec.toTarEntry(name, entry)),
    );

    // Check the expanded size so the saved archive can pass the same limit on reopen.
    if (tar.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(
        'Archives larger than 256 MiB are not supported in memory.',
      );
    }
    return compressed ? compress(tar) : tar;
  }

  private static toTarEntry(name: string, entry: Entry): TarEntry {
    // Preserve unrelated PAX metadata and discard fields tied to the original entry.
    const pax = { ...entry.header.pax };
    delete pax.path;
    delete pax.size;
    delete pax.mtime;

    // Tar names are relative. PAX carries milliseconds beyond the base header's precision.
    const header: TarHeader = {
      ...entry.header,
      name: name === '/' ? './' : name.slice(1),
      size: entry.data.byteLength,
      pax: { ...pax, mtime: String(entry.mtime / 1000) },
    };
    return { header, body: entry.data };
  }
}

const compress = promisify(gzip);
const decompress = promisify(gunzip);

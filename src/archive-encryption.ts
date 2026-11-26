import {
  createMessage,
  decrypt,
  encrypt,
  enums,
  readMessage,
  type Message,
} from 'openpgp';
import { MAX_ARCHIVE_BYTES } from './archive-codec';

/** The filesystem provider accepts these suffixes when mounting an OpenPGP archive. */
export const ENCRYPTED_ARCHIVE_SUFFIX = /\.(gpg|pgp|asc)$/i;

/** Signals that the user dismissed the password prompt so the mount can stop quietly. */
export class ArchiveUnlockCancelled extends Error {
  constructor() {
    super('Archive unlock cancelled. Run Mount Archive to try again.');
  }
}

export interface ArchivePayload {
  /** Supplies plaintext tar or gzip bytes to the archive codec. */
  bytes: Uint8Array;
  /** Re-encrypts the store's serialized edits when the backing file uses OpenPGP. */
  encrypt?: (bytes: Uint8Array) => Promise<Uint8Array>;
}

/** Opens the backing bytes and prompts for an OpenPGP archive's password when needed. */
export async function unlockArchive(
  bytes: Uint8Array,
  filename: string,
  requestPassword: () => PromiseLike<string | undefined>,
): Promise<ArchivePayload> {
  // Bound the backing bytes before parsing an OpenPGP message in memory.
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Archive exceeds 256 MiB.');
  }
  const armored = armorHeader.equals(bytes.subarray(0, armorHeader.length));
  const message = await readArchiveMessage(bytes, filename, armored);
  if (!message) return { bytes };
  requireSinglePassword(message);

  const password = await requestPassword();
  if (password === undefined) throw new ArchiveUnlockCancelled();

  // The store keeps the save callback for the mount so edits reuse its password and armor format.
  return {
    bytes: await decryptArchiveMessage(message, password),
    encrypt: (updated) => encryptArchiveMessage(updated, password, armored),
  };
}

type OpenPgpMessage = Message<string | Uint8Array>;

const armorHeader = Buffer.from('-----BEGIN PGP MESSAGE-----');
// The decompressed OpenPGP message includes packet headers around the tar payload.
const limits = { maxDecompressedMessageSize: MAX_ARCHIVE_BYTES + 64 * 1024 };

async function readArchiveMessage(
  bytes: Uint8Array,
  filename: string,
  armored: boolean,
): Promise<OpenPgpMessage | undefined> {
  const encryptedSuffix = ENCRYPTED_ARCHIVE_SUFFIX.test(filename);
  // A symlink's canonical backing file can have a different suffix.
  if (!armored && !encryptedSuffix && !hasOpenPgpHeader(bytes[0])) {
    return undefined;
  }

  return (
    armored
      ? readMessage({
          armoredMessage: new TextDecoder().decode(bytes),
          config: limits,
        })
      : readMessage({ binaryMessage: bytes, config: limits })
  ).catch((error: unknown) => {
    if (armored || encryptedSuffix) {
      throw new Error('Invalid OpenPGP archive.', { cause: error });
    }
    // A plain tar pathname can start with a byte that resembles an OpenPGP header.
    return undefined;
  });
}

function requireSinglePassword(message: OpenPgpMessage): void {
  // Saving with one password must preserve access for everyone who could open the original.
  if (message.packets.findPacket(enums.packet.publicKeyEncryptedSessionKey)) {
    throw new Error(
      'Select an OpenPGP archive encrypted with a password only.',
    );
  }
  const passwordPackets = message.packets.filterByTag(
    enums.packet.symEncryptedSessionKey,
  );
  if (passwordPackets.length !== 1) {
    throw new Error(
      'The OpenPGP archive must be encrypted with a single password.',
    );
  }
}

async function decryptArchiveMessage(
  message: OpenPgpMessage,
  password: string,
): Promise<Uint8Array> {
  const { data, signatures } = await decrypt({
    message,
    passwords: [password],
    format: 'binary',
    config: limits,
  }).catch((error: unknown) => {
    throw new Error(
      'Could not decrypt the archive. Check the password and try again.',
      { cause: error },
    );
  });
  // Re-encryption would discard signatures made over the original archive.
  if (signatures.length) {
    throw new Error(
      'Editing signed OpenPGP archives would remove their signatures.',
    );
  }
  return data;
}

async function encryptArchiveMessage(
  bytes: Uint8Array,
  password: string,
  armored: boolean,
): Promise<Uint8Array> {
  const options = {
    message: await createMessage({ binary: bytes }),
    passwords: [password],
  };
  const encrypted = armored
    ? Buffer.from(await encrypt({ ...options, format: 'armored' }))
    : await encrypt({ ...options, format: 'binary' });
  // Encryption and armor add overhead that counts toward the on-disk limit.
  if (encrypted.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('The encrypted archive exceeds 256 MiB.');
  }
  return encrypted;
}

function hasOpenPgpHeader(header: number | undefined): boolean {
  if (header === undefined || !(header & 0x80)) return false;
  // The packet tag uses different bits in the old and new OpenPGP header formats.
  const tag = header & 0x40 ? header & 0x3f : (header >> 2) & 0x0f;
  return (
    tag === enums.packet.symEncryptedSessionKey ||
    tag === enums.packet.publicKeyEncryptedSessionKey ||
    tag === enums.packet.marker
  );
}

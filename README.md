# Vaultual

Vaultual mounts tar archives as editable, in-memory workspace folders, including
archives encrypted with an OpenPGP password.

## Mount an archive

1. Right-click a `.tar`, `.tar.gz`, `.tgz`, `.gpg`, `.pgp`, or `.asc` file in
   Explorer and choose **Vaultual: Mount Archive**. You can also select the
   archive from the Command Palette.
2. For an OpenPGP archive, enter its password in the masked VS Code prompt.
3. Browse and edit its contents in the new **filename (archive)** workspace root.
   Every save rewrites the entire original archive. Encrypted archives are
   re-encrypted with the same password before the replacement is written.

Creating, renaming, and deleting files or directories also rewrites the archive.
Compression is detected from the contents and retained when writing. Multiple
archives can be mounted; mounting the same archive twice reuses its root. Saved
workspace roots reopen their backing archive when VS Code restarts. Remove the
workspace folder to unmount it. Vaultual keeps the password in memory while the
archive is mounted and prompts again when the archive reopens.

The archive stays in memory without extracting its files to disk. Saves are
serialized per mounted archive: the complete replacement is written to a sibling
temporary file, flushed, and renamed over the original. Memory and file change
events are updated only after replacement succeeds. A failed save leaves the
editor unsaved and the previous in-memory snapshot available.

Before replacing an archive, Vaultual compares its current disk contents against
the last loaded or saved version. If another program has changed it, saving is
refused. Remove and remount that workspace folder to reload the disk version.
External edits are not automatically reflected in the mounted folder. The check
is optimistic, so use one writer per archive: it cannot lock out another process
writing between the check and the rename. Replacement uses the host filesystem's
rename semantics; network filesystems may provide weaker guarantees.

## Supported archives

- Regular files and directories in USTAR, PAX, and GNU tar archives. Binary and
  empty files, long and Unicode names, file permissions, ownership fields, and
  modification timestamps survive rewrites. Names remain case-sensitive on all
  operating systems.
- Tar and gzip-compressed tar encrypted with a single OpenPGP password, for
  example `gpg --symmetric archive.tar.gz`. Binary and ASCII-armored messages
  retain their encoding on save. Recipient-key and signed OpenPGP messages are
  outside the supported formats.
- Symlinks, hard links, device files, FIFOs, PAX sparse files, duplicate paths,
  and unsafe paths are rejected when mounting.
- **Warning:** Vaultual does not support unrecognized tar entry types, including
  old GNU sparse entries. Saving can rewrite them as regular files.
- Archives are limited to 256 MiB on disk and after decompression, and 100,000
  in-memory entries including inferred directories. Rewriting may add directory
  and PAX metadata, so archives close to the size limit may fail to save.
- Backing archives must be on the extension host filesystem (`file:` URIs),
  including files on a remote extension host. Browser-only extension hosts are
  not supported. The archive and its parent directory must permit replacement.

Tar parsing uses [modern-tar](https://github.com/ayuhito/modern-tar), gzip uses
Node's built-in zlib, and encryption uses [OpenPGP.js](https://openpgpjs.org/).
Vaultual includes its runtime dependencies for Windows, macOS, and Linux.

## Development

Use Node.js 26 LTS or newer, npm, and VS Code 1.146 or newer.

1. Run `nvm use` if you use nvm.
2. Run `npm install`.
3. Open this folder in VS Code and press **F5** to launch an Extension Development Host.
4. In the new window, open a folder containing a tar archive and mount it.

F5 starts the bundle and type-check watchers. Breakpoints in `src/extension.ts`
use the development bundle's source map. Reload the development host window after
changing extension code; restart the debug session after changing the manifest.

| Command                    | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `npm run compile`          | Type-check and build a development bundle with source maps. |
| `npm run watch`            | Rebuild the bundle as files change.                         |
| `npm run watch:types`      | Type-check as files change, in a separate terminal.         |
| `npm run check`            | Check strict TypeScript types and formatting.               |
| `npm test`                 | Build and run the command and lifecycle unit tests.         |
| `npm run test:integration` | Run the command in an isolated VS Code extension host.      |
| `npm run format`           | Format project files.                                       |
| `npm run build`            | Run checks and build a minified production bundle.          |
| `npm run package`          | Build and create a local installable `.vsix`.               |

TypeScript and esbuild are pinned to stable releases. The VS Code API types
resolve to the newest published stable version between 1.74 and 1.146 inclusive;
API type packages are not published for every VS Code release. The upper bound
keeps the types compatible with our minimum VS Code version. Formatting and
packaging tools resolve their latest stable releases on the first install.
Commit the generated `package-lock.json`; use `npm ci` for subsequent clean
installs and CI.

## Tests

`npm test` uses Node's built-in test runner, the real tar library, and a stub of
the VS Code API. Tests cover tar/gzip round trips, independent USTAR/PAX/GNU
fixtures, metadata, filesystem operations, path validation, failed saves,
concurrent saves, external changes, provider events, and command registration.
The TypeScript sources are bundled for tests with the same esbuild toolchain.

`npm run test:integration` launches the installed VS Code in a temporary profile
with other extensions disabled. It mounts an archive, edits and saves a real
document, verifies the backing tar, and exercises directory operations in the
real extension host, then removes the temporary profile.
It requires VS Code 1.146 or newer and a graphical desktop session. On macOS it
uses `/Applications/Visual Studio Code.app` by default. For another installation,
set `VSCODE_EXECUTABLE_PATH` to the editor executable (`Code.exe` on Windows or
the absolute path to `code` on Linux).

To debug the integration test in VS Code, choose **Vaultual Integration Tests**
in Run and Debug, then press **F5**. This uses the running editor's version.
Tests are excluded from the packaged extension.

## Structure

- `src/extension.ts` registers the provider and commands and appends mounted
  archives to the workspace.
- `src/archive.ts` holds the in-memory filesystem, backed by the tar/gzip codec.
- `src/archive-encryption.ts` unlocks OpenPGP archives and re-encrypts updates.
- `src/archive-store.ts` serializes transactions and persists complete archives.
- `src/tar-file-system.ts` adapts the model to VS Code's filesystem API.
- `package.json` declares commands and Explorer menus. Activation is lazy for
  commands and restored `vaultual:` workspace roots.
- `esbuild.mjs` bundles the Node extension and tar library. The VS Code host
  provides `vscode`, and the VSIX includes OpenPGP.js as a separate module.
- `.vscode/` contains debugging, build tasks, and editor settings.
- `.vscodeignore` limits the VSIX contents to the production entry point and
  extension metadata/docs.

The extension runs in the workspace extension host so archive access happens
alongside the workspace files.

## Local packaging

Run `npm run package`, then use **Extensions: Install from VSIX...** in VS Code.
The project is private and unlicensed. The packaging command allows missing
repository and license metadata for local development. Before Marketplace
publication, choose a license, set the real `publisher` and repository metadata,
and review the release contents with `npx vsce ls`.

## References

- [VS Code extension guide](https://code.visualstudio.com/api/get-started/your-first-extension)
- [Bundling extensions with esbuild](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
- [FileSystemProvider API](https://code.visualstudio.com/api/references/vscode-api#FileSystemProvider)

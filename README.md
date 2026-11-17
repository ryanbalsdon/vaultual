# Vaultual

Vaultual is a VS Code extension in development. Its intended purpose is to mount
a virtual filesystem backed by a GPG-encrypted tar archive as a root folder in a
VS Code workspace.

This initial skeleton contributes **Vaultual: Hello World** to the Command Palette.
Running it displays **Hello from Vaultual!**. Archive handling, encryption, and
virtual filesystem mounting are not implemented yet.

## Development

Use Node.js 26 LTS or newer, npm, and VS Code 1.146 or newer.

1. Run `nvm use` if you use nvm.
2. Run `npm install`.
3. Open this folder in VS Code and press **F5** to launch an Extension Development Host.
4. In the new window, open the Command Palette and run **Vaultual: Hello World**.

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

`npm test` uses Node's built-in test runner and a stub of the VS Code API to
exercise the built extension. It checks command registration against the
manifest, the greeting, asynchronous completion and error propagation, and
disposable cleanup. No additional test dependencies are required.

`npm run test:integration` launches the installed VS Code in a temporary profile
with other extensions disabled. It verifies discovery, implicit activation, and
command execution in the real extension host, then removes the temporary profile.
It requires VS Code 1.146 or newer and a graphical desktop session. On macOS it
uses `/Applications/Visual Studio Code.app` by default. For another installation,
set `VSCODE_EXECUTABLE_PATH` to the editor executable (`Code.exe` on Windows or
the absolute path to `code` on Linux).

To debug the integration test in VS Code, choose **Vaultual Integration Tests**
in Run and Debug, then press **F5**. This uses the running editor's version.
Tests are excluded from the packaged extension.

## Structure

- `src/extension.ts` registers the command when invoked and adds its disposable
  to the extension context so VS Code cleans it up automatically.
- `package.json` declares the command; VS Code activates the extension lazily
  from that contribution without an explicit activation event.
- `esbuild.mjs` bundles the Node extension, leaving the host-provided `vscode`
  module external. There are no runtime npm dependencies.
- `.vscode/` contains debugging, build tasks, and editor settings.
- `.vscodeignore` limits the VSIX contents to the production entry point and
  extension metadata/docs.

The extension runs in the workspace extension host, including remote workspaces,
so future archive access can happen alongside the workspace files. Browser-only
extension hosts are not supported by this skeleton.

## Local packaging

Run `npm run package`, then use **Extensions: Install from VSIX...** in VS Code.
The project is private and unlicensed. The packaging command allows missing
repository and license metadata for local development. Before Marketplace
publication, choose a license, set the real `publisher` and repository metadata,
and review the release contents with `npx vsce ls --no-dependencies`.

## References

- [VS Code extension guide](https://code.visualstudio.com/api/get-started/your-first-extension)
- [Bundling extensions with esbuild](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
- [FileSystemProvider API](https://code.visualstudio.com/api/references/vscode-api#FileSystemProvider)

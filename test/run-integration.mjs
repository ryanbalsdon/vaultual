import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const configuredExecutable = process.env.VSCODE_EXECUTABLE_PATH;
const macExecutable = ['Code', 'Electron']
  .map((name) => `/Applications/Visual Studio Code.app/Contents/MacOS/${name}`)
  .find((candidate) => existsSync(candidate));
const executable =
  configuredExecutable ??
  (process.platform === 'darwin' ? macExecutable : undefined);

if (!executable || !existsSync(executable)) {
  throw new Error(
    'Set VSCODE_EXECUTABLE_PATH to the VS Code executable (Code.exe on Windows, code on Linux).',
  );
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'vaultual-test-'),
);
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    executable,
    [
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${path.join(root, 'test/integration/index.cjs')}`,
      `--user-data-dir=${path.join(temporaryDirectory, 'user-data')}`,
      `--extensions-dir=${path.join(temporaryDirectory, 'extensions')}`,
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--new-window',
    ],
    { env, stdio: 'inherit', timeout: 60_000 },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(
          `VS Code exited with ${signal}. Run integration tests in a graphical desktop session; the host timeout is 60 seconds.`,
        );
      }
      resolve(code ?? 1);
    });
  });
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

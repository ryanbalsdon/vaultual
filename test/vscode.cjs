const { pathToFileURL, fileURLToPath } = require('node:url');

class Uri {
  constructor(url) {
    this.url = url;
  }
  static parse(value) {
    return new Uri(new URL(value));
  }
  static file(value) {
    return new Uri(pathToFileURL(value));
  }
  static from({ scheme, authority, path }) {
    return Uri.parse(
      `${scheme}://${authority}${path.split('/').map(encodeURIComponent).join('/')}`,
    );
  }
  get scheme() {
    return this.url.protocol.slice(0, -1);
  }
  get authority() {
    return this.url.host;
  }
  get path() {
    return decodeURIComponent(this.url.pathname);
  }
  get fsPath() {
    return fileURLToPath(this.url);
  }
  with({ path }) {
    return Uri.from({ scheme: this.scheme, authority: this.authority, path });
  }
  toString() {
    return this.url.href;
  }
}

class Disposable {
  constructor(dispose) {
    this.dispose = dispose;
  }
}
class EventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}
class FileSystemError extends Error {}
for (const code of [
  'FileNotFound',
  'FileExists',
  'FileIsADirectory',
  'FileNotADirectory',
  'NoPermissions',
  'Unavailable',
]) {
  FileSystemError[code] = (message) =>
    Object.assign(new FileSystemError(String(message)), { code });
}

exports.createVSCode = function createVSCode() {
  const commands = new Map();
  const providers = new Map();
  const folderChanges = new EventEmitter();
  return {
    Uri,
    Disposable,
    EventEmitter,
    FileSystemError,
    FileType: { File: 1, Directory: 2 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    commands: {
      registerCommand(id, handler) {
        if (commands.has(id)) throw new Error('Duplicate command');
        commands.set(id, handler);
        return new Disposable(() => commands.delete(id));
      },
    },
    window: {
      showErrorMessage: async () => {},
      showOpenDialog: async () => undefined,
    },
    workspace: {
      workspaceFolders: [],
      onDidChangeWorkspaceFolders: folderChanges.event,
      registerFileSystemProvider(scheme, provider) {
        providers.set(scheme, provider);
        return new Disposable(() => providers.delete(scheme));
      },
      updateWorkspaceFolders(index, count, ...folders) {
        this.workspaceFolders.splice(index, count, ...folders);
        return true;
      },
    },
    registeredCommands: commands,
    registeredProviders: providers,
    folderChanges,
  };
};

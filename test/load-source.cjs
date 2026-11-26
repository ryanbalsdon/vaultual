const { buildSync } = require('esbuild');
const path = require('node:path');
const cache = new Map();

// Bundle the same TypeScript sources as the extension, substituting only the
// VS Code host API. Node builtins and the real tar implementation still run.
exports.loadSource = function loadSource(name, vscode) {
  const filename = path.resolve(__dirname, '../src', name + '.ts');
  let source = cache.get(filename);
  if (!source) {
    source = buildSync({
      entryPoints: [filename],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
      write: false,
    }).outputFiles[0].text;
    cache.set(filename, source);
  }
  const module = { exports: {} };
  const execute = new Function('require', 'module', 'exports', source);
  execute(
    (id) => (id === 'vscode' ? vscode : require(id)),
    module,
    module.exports,
  );
  return module.exports;
};

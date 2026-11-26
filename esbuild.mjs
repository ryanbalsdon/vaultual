import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const context = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode', 'openpgp'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  plugins: [
    {
      name: 'watch-status',
      setup(build) {
        build.onStart(() => console.log('[watch] build started'));
        build.onEnd((result) => {
          for (const { text, location } of result.errors) {
            console.error(`✘ [ERROR] ${text}`);
            if (location) {
              console.error(
                `    ${location.file}:${location.line}:${location.column}:`,
              );
            }
          }
          console.log('[watch] build finished');
        });
      },
    },
  ],
});

if (watch) {
  await context.watch();
} else {
  try {
    await context.rebuild();
  } finally {
    await context.dispose();
  }
}

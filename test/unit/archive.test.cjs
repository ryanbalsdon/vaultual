const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gzipSync } = require('node:zlib');
const fs = require('node:fs/promises');
const path = require('node:path');
const { packTar, unpackTar } = require('modern-tar');
const { loadSource } = require('../load-source.cjs');
const { Archive, archivePath } = loadSource('archive');

const bytes = (text) => new TextEncoder().encode(text);
const text = (value) => new TextDecoder().decode(value);
const file = (name, body = 'original', extra = {}) => ({
  header: { name, type: 'file', size: bytes(body).length, ...extra },
  body: bytes(body),
});

test('reads and rewrites independent USTAR, PAX, GNU, and gzip fixtures', async () => {
  for (const filename of ['ustar.tar', 'pax.tar', 'gnu.tar', 'pax.tar.gz']) {
    const source = await fs.readFile(path.join(__dirname, '../fixtures', filename));
    const archive = await Archive.decode(source);
    assert.equal(
      text(archive.get('/bin/run.sh').data),
      '#!/bin/sh\necho portable\n',
    );
    assert.equal(archive.get('/empty').header.mode, 0o750);
    assert.equal(archive.get('/bin/run.sh').header.mode, 0o751);
    const roundtrip = await Archive.decode(await archive.encode());
    assert.equal(roundtrip.compressed, filename.endsWith('.gz'));
    assert.equal(roundtrip.get('/bin/run.sh').header.uid, 123);
    assert.equal(roundtrip.get('/bin/run.sh').header.gid, 456);
    assert.equal(roundtrip.get('/bin/run.sh').mtime, 1700000000000);
    if (filename !== 'ustar.tar')
      assert.equal(
        text(roundtrip.get('/long/' + 'x'.repeat(300) + '.txt').data),
        'long',
      );
  }
});

test('tar and gzip round trips preserve binary, empty, Unicode, and long names and metadata', async () => {
  const longName = 'nested/' + 'é'.repeat(150) + '.txt';
  const entries = [
    file(longName, 'hello', {
      mode: 0o751,
      uid: 123,
      gid: 456,
      mtime: new Date(1234567890000),
      pax: { comment: 'keep me' },
    }),
    { header: { name: 'empty/', type: 'directory', size: 0, mode: 0o700 } },
    file('empty.txt', ''),
    {
      header: { name: 'binary', size: 4, type: 'file' },
      body: new Uint8Array([0, 255, 128, 13]),
    },
  ];
  for (const compressed of [false, true]) {
    const tar = await packTar(entries);
    const archive = await Archive.decode(compressed ? gzipSync(tar) : tar);
    assert.equal(archive.get('/nested').header.type, 'directory');
    assert.equal(archive.get('/empty').header.mode, 0o700);
    assert.equal(archive.get('/empty.txt').data.length, 0);
    archive.rename('/nested', '/renamed', false);
    archive.write(
      '/renamed/' + longName.slice(7),
      bytes('updated'),
      false,
      true,
    );
    const encoded = await archive.encode();
    assert.equal(encoded[0] === 0x1f, compressed);
    const reopened = await Archive.decode(encoded);
    const entry = reopened.get('/renamed/' + longName.slice(7));
    assert.equal(text(entry.data), 'updated');
    assert.equal(entry.header.mode, 0o751);
    assert.equal(entry.header.uid, 123);
    assert.equal(entry.header.gid, 456);
    assert.equal(entry.header.pax.comment, 'keep me');
    assert.deepEqual([...reopened.get('/binary').data], [0, 255, 128, 13]);
  }
});

test('unchanged file timestamps and ownership survive a rewrite', async () => {
  const source = await packTar([
    file('run.sh', 'echo hello', {
      mtime: new Date(1700000000000),
      mode: 0o755,
      uid: 23,
      gid: 42,
    }),
  ]);
  const archive = await Archive.decode(source);
  archive.write('/another', bytes('new'), true, false);
  const entries = await unpackTar(await archive.encode(), { strict: true });
  const entry = entries.find(({ header }) => header.name === 'run.sh');
  assert.equal(entry.header.mtime.getTime(), 1700000000000);
  assert.equal(entry.header.mode, 0o755);
  assert.equal(entry.header.uid, 23);
});

test('inferring directories does not change explicit directory timestamps', async () => {
  const archive = await Archive.decode(
    await packTar([
      {
        header: {
          name: './',
          type: 'directory',
          size: 0,
          mtime: new Date(123456000),
        },
      },
      {
        header: {
          name: 'parent/',
          type: 'directory',
          size: 0,
          mtime: new Date(123456000),
        },
      },
      file('parent/implicit/file', 'value'),
    ]),
  );
  assert.equal(archive.get('/').mtime, 123456000);
  assert.equal(archive.get('/parent').mtime, 123456000);
});

test('archives missing end markers are refused', async () => {
  const valid = await packTar([file('sample')]);
  await assert.rejects(
    Archive.decode(valid.slice(0, 1024)),
    /truncated/,
  );
});

test('filesystem rules, nested moves, overwrites, and recursive deletes', async () => {
  const archive = await Archive.decode(await packTar([]));
  archive.mkdir('/a/b');
  archive.write('/a/b/file', bytes('value'), true, false);
  assert.throws(() => archive.write('/missing/file', bytes('x'), true, false), {
    code: 'FileNotFound',
  });
  assert.throws(() => archive.write('/a', bytes('x'), true, true), {
    code: 'FileIsADirectory',
  });
  assert.throws(() => archive.write('/a/b/file', bytes('x'), true, false), {
    code: 'FileExists',
  });
  assert.throws(() => archive.write('/missing', bytes('x'), false, true), {
    code: 'FileNotFound',
  });
  assert.throws(() => archive.mkdir('/a/b/file/child'), {
    code: 'FileNotADirectory',
  });
  assert.throws(() => archive.delete('/a', false), { code: 'NoPermissions' });
  assert.throws(() => archive.rename('/a', '/a/b/loop', true), {
    code: 'NoPermissions',
  });
  assert.throws(() => archive.delete('/', true), { code: 'NoPermissions' });
  archive.rename('/a', '/moved', false);
  assert.equal(text(archive.get('/moved/b/file').data), 'value');
  archive.write('/target', bytes('old'), true, false);
  assert.throws(() => archive.rename('/moved/b/file', '/target', false), {
    code: 'FileExists',
  });
  archive.rename('/moved/b/file', '/target', true);
  assert.equal(text(archive.get('/target').data), 'value');
  archive.delete('/moved', true);
  assert.throws(() => archive.get('/moved/b'), { code: 'FileNotFound' });
  const reopened = await Archive.decode(await archive.encode());
  assert.equal(text(reopened.get('/target').data), 'value');
});

test('paths use POSIX semantics on every OS and unsafe paths are refused', () => {
  assert.equal(archivePath('./one//./two/'), '/one/two');
  for (const name of [
    '../escape',
    'a/../b',
    '/absolute',
    'C:/drive',
    'a\\b',
    '\\\\server\\file',
    'nul\0byte',
  ]) {
    assert.throws(() => archivePath(name), { code: 'NoPermissions' });
  }
});

test('reject unsafe, duplicate, conflicting, linked, sparse, and corrupt archives', async () => {
  const invalidEntries = [
    [file('../escape')],
    [file('one'), file('./one')],
    [file('parent'), file('parent/child')],
    [
      {
        header: { name: 'link', linkname: 'target', size: 0, type: 'symlink' },
      },
    ],
    [{ header: { name: 'link', linkname: 'target', size: 0, type: 'link' } }],
    [file('sparse', 'x', { pax: { 'GNU.sparse.size': '1000' } })],
  ];
  for (const entries of invalidEntries)
    await assert.rejects(Archive.decode(await packTar(entries)));
  await assert.rejects(Archive.decode(bytes('not tar')));
  const valid = await packTar([file('test')]);
  const corrupt = valid.slice();
  corrupt[0] ^= 1;
  await assert.rejects(Archive.decode(corrupt));
  await assert.rejects(Archive.decode(valid.slice(0, 513)));
  const trailing = new Uint8Array(valid.length + 512);
  trailing.set(valid);
  trailing[valid.length] = 1;
  await assert.rejects(Archive.decode(trailing));
});

test('draft mutation does not change the original snapshot', async () => {
  const archive = await Archive.decode(await packTar([file('original')]));
  const draft = archive.fork();
  draft.write('/original', bytes('draft'), false, true);
  assert.equal(text(archive.get('/original').data), 'original');
  assert.equal(text(draft.get('/original').data), 'draft');
});

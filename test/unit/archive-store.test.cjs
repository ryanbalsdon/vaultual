const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { packTar, unpackTar } = require('modern-tar');
const { loadSource } = require('../load-source.cjs');
const { ArchiveStore, DiskArchiveStorage } = loadSource('archive-store');
const bytes = (text) => new TextEncoder().encode(text);
const text = (value) => new TextDecoder().decode(value);

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultual-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'archive with spaces.tar');
  await fs.writeFile(filename, await packTar([]));
  return { directory, filename };
}

test('concurrent saves serialize complete snapshots and preserve all files', async () => {
  const storage = {
    bytes: await packTar([]),
    writes: 0,
    active: 0,
    async read() {
      return this.bytes;
    },
    async replace(expected, next) {
      assert.equal(this.active++, 0, 'Only one replacement may run at a time');
      assert.deepEqual(this.bytes, expected);
      await new Promise((resolve) => setImmediate(resolve));
      this.bytes = next;
      this.writes++;
      this.active--;
    },
  };
  const store = await ArchiveStore.open(storage);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      store.update((draft) =>
        draft.write(`/file-${index}`, bytes(String(index)), true, true),
      ),
    ),
  );
  assert.equal(storage.writes, 10);
  const files = (await unpackTar(storage.bytes)).filter(
    ({ header }) => header.type === 'file',
  );
  assert.equal(files.length, 10);
  for (const { header, data } of files)
    assert.equal(text(data), header.name.slice(5));
});

test('failed persistence leaves memory and baseline intact and later saves work', async () => {
  const storage = {
    bytes: await packTar([]),
    fail: true,
    async read() {
      return this.bytes;
    },
    async replace(expected, next) {
      assert.deepEqual(expected, this.bytes);
      if (this.fail) throw new Error('Disk full');
      this.bytes = next;
    },
  };
  const store = await ArchiveStore.open(storage);
  await assert.rejects(
    store.update((draft) => draft.write('/failed', bytes('lost'), true, true)),
    /Disk full/,
  );
  assert.equal(store.archive.entries.has('/failed'), false);
  storage.fail = false;
  await store.update((draft) => draft.write('/saved', bytes('ok'), true, true));
  assert.equal(text(store.archive.get('/saved').data), 'ok');
  assert.equal(store.archive.entries.has('/failed'), false);
});

test('disk replacement preserves permissions and removes temporary files', async (t) => {
  const { directory, filename } = await temporary(t);
  if (process.platform !== 'win32') await fs.chmod(filename, 0o640);
  const store = await ArchiveStore.open(new DiskArchiveStorage(filename));
  await store.update((draft) =>
    draft.write('/hello', bytes('saved'), true, true),
  );
  const reopened = await ArchiveStore.open(new DiskArchiveStorage(filename));
  assert.equal(text(reopened.archive.get('/hello').data), 'saved');
  if (process.platform !== 'win32')
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o640);
  assert.deepEqual(await fs.readdir(directory), [path.basename(filename)]);
});

test('external modifications are not overwritten and failed writes clean up temporary files', async (t) => {
  const { directory, filename } = await temporary(t);
  const store = await ArchiveStore.open(new DiskArchiveStorage(filename));
  const external = await packTar([
    { header: { name: 'external', type: 'file', size: 1 }, body: bytes('x') },
  ]);
  await fs.writeFile(filename, external);
  await assert.rejects(
    store.update((draft) => draft.write('/hello', bytes('edit'), true, true)),
    { code: 'Unavailable' },
  );
  assert.deepEqual(await fs.readFile(filename), Buffer.from(external));
  assert.equal(store.archive.entries.has('/hello'), false);
  assert.deepEqual(await fs.readdir(directory), [path.basename(filename)]);
});

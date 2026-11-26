# Tar compatibility fixtures

`ustar.tar`, `pax.tar`, and `gnu.tar` were generated with Python's standard
`tarfile` module using `USTAR_FORMAT`, `PAX_FORMAT`, and `GNU_FORMAT` respectively.
They provide inputs independent of the extension's tar implementation. Python is
not required to run the tests.

`pax.tar.gz` is `pax.tar` compressed with `gzip -n` to exercise reading and
rewriting a gzip-compressed archive.

`pax.tar.gpg` and `pax.tgz.asc` are the binary and ASCII-armored OpenPGP
fixtures, generated with GnuPG 2.5.24 from `pax.tar` and `pax.tar.gz`
respectively. Both use the fixture password `vaultual fixture password`.
Regenerate them with the following commands and enter the fixture password
when prompted. The tests use the checked-in files and run without GnuPG.

```sh
gpg --compress-algo zlib --symmetric --output pax.tar.gpg pax.tar
gpg --compress-algo zlib --symmetric --armor --output pax.tgz.asc pax.tar.gz
```

Each contains an empty directory and `bin/run.sh` with fixed permissions,
ownership, and modification time. The PAX and GNU archives also include a file
with a 300-character basename to exercise their extended filename records.

`workspace/` is the initial folder for debugging integration tests. Starting with
an existing workspace folder avoids restarting the extension host when the test
adds its first archive root.

# Tar compatibility fixtures

`ustar.tar`, `pax.tar`, and `gnu.tar` were generated with Python's standard
`tarfile` module using `USTAR_FORMAT`, `PAX_FORMAT`, and `GNU_FORMAT` respectively.
They provide inputs independent of the extension's tar implementation. Python is
not required to run the tests.

`pax.tar.gz` is `pax.tar` compressed with `gzip -n` to exercise reading and
rewriting a gzip-compressed archive.

Each contains an empty directory and `bin/run.sh` with fixed permissions,
ownership, and modification time. The PAX and GNU archives also include a file
with a 300-character basename to exercise their extended filename records.

`workspace/` is the initial folder for debugging integration tests. Starting with
an existing workspace folder avoids restarting the extension host when the test
adds its first archive root.

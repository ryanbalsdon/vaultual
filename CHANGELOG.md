# Changelog

## Unreleased

- Mount plaintext tar and gzip-compressed tar archives as editable workspace roots.
- Rewrite complete archives on saves and filesystem mutations using serialized
  transactions, temporary-file replacement, and external-change checks.
- Add archive, storage, provider, and extension-host tests.

## 0.0.1

- Add the initial extension skeleton and `Vaultual: Hello World` command.

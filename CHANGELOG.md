# Changelog

## 1.0.1

- Add a Vaultual icon and a shorter Marketplace overview.

## 1.0.0

- Mount plaintext tar and gzip-compressed tar archives as editable workspace roots.
- Rewrite complete archives on saves and filesystem mutations using serialized
  transactions, temporary-file replacement, and external-change checks.
- Add archive, storage, provider, and extension-host tests.
- Mount password-encrypted OpenPGP tar archives with a masked VS Code prompt
  and retain encryption when saving changes.
- Remove the scaffold's `Vaultual: Hello World` command.

## 0.0.1

- Add the initial extension skeleton and `Vaultual: Hello World` command.

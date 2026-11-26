# Vaultual

Edit **password-encrypted OpenPGP tar archives** directly in VS Code. Vaultual
mounts the archive as a folder in Explorer, so you can browse and edit its files
without extracting them to disk. When you save, Vaultual re-encrypts the archive
with the same password.

## Get started

1. Right-click an archive in Explorer and choose **Mount Archive**, or run the command from the Command Palette.
2. Enter the password if the archive is encrypted.
3. Open and edit files in the new workspace folder. Remove the folder to unmount it.

Vaultual also supports unencrypted `.tar`, `.tar.gz`, and `.tgz` archives and
preserves gzip compression when you save.

**Saving replaces the original archive.** Use archives containing regular files
and directories. Old GNU sparse entries can be rewritten as regular files.

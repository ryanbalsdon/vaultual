# Vaultual

Browse and edit tar archives directly in VS Code. Vaultual mounts an archive as a
folder in Explorer, so you can work with its files without extracting them to disk.

## Get started

1. Right-click an archive in Explorer and choose **Vaultual: Mount Archive**, or run
   the command from the Command Palette.
2. Enter the password if the archive is encrypted.
3. Open and edit files in the new workspace folder. Remove the folder to unmount it.

Vaultual supports `.tar`, `.tar.gz`, `.tgz`, and password-encrypted OpenPGP tar
archives. It preserves compression and encryption when you save.

**Saving replaces the original archive.** Use archives containing regular files
and directories. Old GNU sparse entries can be rewritten as regular files.

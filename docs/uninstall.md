# Uninstall

## CLI

```bash
clawdi uninstall
```

This stops and removes the background service, tears down local agent integrations,
signs out and revokes the OAuth grant, and deletes `~/.clawdi` (or `CLAWDI_HOME`).
Your account data, uploaded sessions, agent registrations, and agents' own files stay.

Add `--remove-cli` to remove the native CLI versions, launcher, and the exact PATH
block added by the Clawdi installer. A native CLI installed by Desktop is removed
automatically. npm and Homebrew installations are kept; use their uninstall commands
to remove those packages.

For scripts, use `clawdi uninstall --yes --json`. Non-interactive shells require
`--yes`; `--json` alone does not confirm removal. The `clawdi.uninstall.v1` envelope
contains a `steps` array with each step's status and message. Cleanup continues after
a failure and exits nonzero if any step failed. Repeating the command is safe.
On Windows, a running native executable's version files are deleted after it exits;
that step reports `scheduled`.

## Desktop

Choose **Uninstall Clawdi…** from the app menu, Help menu, or tray. The native
confirmation dialog explains local cleanup and offers **Also remove the Clawdi
command-line tool**, checked by default only when Desktop installed the native CLI.
Unchecking it keeps the CLI. Account data stays.

Desktop runs the CLI cleanup, clears local app data (including sign-in storage,
settings, and logs), and removes its login item. On macOS it moves the app bundle
to the Trash. On Windows it launches the NSIS uninstaller and clears locked app
files after Desktop exits. On Linux it shows package-manager or AppImage removal
instructions. The app then quits.

The Windows uninstaller also attempts local CLI cleanup before removing app files.
It keeps a CLI installed independently of Desktop and completes even if cleanup fails.
Upgrades only stop sync temporarily; they keep local state and integrations.

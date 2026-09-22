# rclone for gsynchro

`gsynchro` uses Google Drive as an ordinary local filesystem.

This guide mounts Google Drive with `rclone` at:

```text
~/GDrive
```

`gsynchro` does not call the Google Drive API directly.

This guide is for Ubuntu and other Linux distributions with FUSE 3 support. Do not use the Google Drive filesystem exposed by GNOME Online Accounts as the `gsynchro` destination: command-line applications can see opaque Google IDs instead of the normal file and directory names. Use the rclone mount described below as the single local representation of Drive.

---

## 1. Install rclone

On Ubuntu:

```bash
sudo -v
sudo apt install fuse3
curl https://rclone.org/install.sh | sudo bash
```

Verify the installation:

```bash
rclone version
```

The installer command is published by rclone. For a manual installation or another distribution, use the [official installation guide](https://rclone.org/install/). Avoid the Snap package for this use case: rclone documents that its strict confinement does not support `rclone mount`.

---

## 2. Configure Google Drive

Start the interactive configuration:

```bash
rclone config
```

Create a new remote:

```text
n) New remote
```

Recommended name:

```text
gdrive
```

Storage type:

```text
Google Drive
```

Create and use your own Google OAuth `client_id` and `client_secret` in Google Cloud Console. rclone documents that its shared Google Drive client ID is being retired during 2026, so leaving these values blank can interrupt an existing mount. Follow rclone's [own client ID guide](https://rclone.org/drive/#making-your-own-client-id).

Select **Full access all files, excluding Application Data Folder**. It is required because `gsynchro` needs to read, create, update, rename, and move selected files:

```text
1 / Full access all files
```

For an ordinary personal Drive, leave the service-account option empty, select `No` for advanced configuration, and select `Yes` for browser-based authentication. The temporary local OAuth callback uses `127.0.0.1`; allow it through a host firewall if the browser cannot complete sign-in.

For a normal My Drive account, select:

```text
Shared Drive: No
```

Save the remote when the configuration is complete.

---

## 3. Your personal OAuth project and token expiry

The Google Cloud project and OAuth client created in the previous step are **your personal credentials**. They are not supplied, owned, or operated by `gsynchro`; `rclone` uses them only to connect your local mount to your Google Drive account.

For a personal setup, it is usually simplest to keep the OAuth consent screen in **Testing**. Google then treats the account you authorize as a test user. For an external app in Testing that requests Google Drive access, Google expires the test-user authorization and its refresh token after seven days. This is expected behaviour, not a `gsynchro` or rclone failure.

If a mount that used to work starts reporting an expired or invalid token, reconnect the remote and complete the browser sign-in again with the same Google account:

```bash
rclone config reconnect gdrive:
```

You can then restart the mount, if necessary:

```bash
systemctl --user restart rclone-gdrive.service
```

Moving the OAuth consent screen to **Production** avoids the Testing-mode seven-day expiry. For a private, personal Drive integration this is generally more work than it is worth. Depending on the selected scopes and audience, Google may require app verification; that process can require a publicly reachable homepage on a domain you own and verify, a privacy policy, and other application details. Review Google's [app audience documentation](https://support.google.com/cloud/answer/13464321) and [OAuth verification requirements](https://support.google.com/cloud/answer/9110914) before choosing that route.

`gsynchro` is planning a future managed OAuth application and supporting website to make this setup easier. Until that is available, each user should create and maintain their own personal Google Cloud project and reconnect it when the Testing token expires.

---

## 4. Verify the remote

List directories:

```bash
rclone lsd gdrive:
```

List files and directories:

```bash
rclone lsf gdrive:
```

Show quota information:

```bash
rclone about gdrive:
```

For example:

```bash
rclone lsd gdrive:develop
```

---

## 5. Create a local mount

Create the mount point:

```bash
mkdir -p ~/GDrive
```

Start the mount manually:

```bash
rclone mount gdrive: ~/GDrive --vfs-cache-mode writes
```

This command remains in the foreground. In another terminal, check the mount:

```bash
ls ~/GDrive
```

Google Drive files and directories should appear with their normal names. `--vfs-cache-mode writes` is important: rclone buffers writes locally, supports normal filesystem write operations, and retries failed uploads.

---

## 6. Test writing

For example:

```bash
mkdir -p ~/GDrive/projects/gsynchro-rclone-test

echo "test" > ~/GDrive/projects/gsynchro-rclone-test/test.md

cat ~/GDrive/projects/gsynchro-rclone-test/test.md

mv \
  ~/GDrive/projects/gsynchro-rclone-test/test.md \
  ~/GDrive/projects/gsynchro-rclone-test/test2.md

rm ~/GDrive/projects/gsynchro-rclone-test/test2.md
rmdir ~/GDrive/projects/gsynchro-rclone-test
```

Also verify the changes in the Google Drive web interface.

---

## 7. Start the mount automatically with systemd

Create this file:

```text
~/.config/systemd/user/rclone-gdrive.service
```

Create its parent directory first:

```bash
mkdir -p ~/.config/systemd/user
```

Contents:

```ini
[Unit]
Description=Rclone Google Drive mount
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/rclone mount gdrive: %h/GDrive \
  --config %h/.config/rclone/rclone.conf \
  --cache-dir %h/.cache/rclone \
  --vfs-cache-mode writes \
  --dir-cache-time 12h \
  --poll-interval 1m \
  --umask 022

ExecStop=/bin/fusermount3 -u %h/GDrive

Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

`Type=notify` makes systemd consider the service started only after rclone has mounted the directory. The explicit configuration and cache paths avoid ambiguity in a service environment. Keep enough free disk space for the VFS write cache; rclone writes data back after files are closed and have been idle for its write-back interval.

Reload the user service manager:

```bash
systemctl --user daemon-reload
```

Enable and start the service:

```bash
systemctl --user enable --now rclone-gdrive.service
```

To keep this user service running after a reboot even before you log in, enable lingering once:

```bash
loginctl enable-linger "$USER"
```

Check its status:

```bash
systemctl --user status rclone-gdrive.service
```

Check the mount:

```bash
mount | grep GDrive
```

Follow the logs:

```bash
journalctl --user -u rclone-gdrive.service -f
```

Restart manually:

```bash
systemctl --user restart rclone-gdrive.service
```

Stop:

```bash
systemctl --user stop rclone-gdrive.service
```

Start:

```bash
systemctl --user start rclone-gdrive.service
```

---

## 8. Unmount manually

If the mount was started manually:

```bash
fusermount3 -u ~/GDrive
```

Alternatively, stop the `rclone mount` process with:

```text
Ctrl+C
```

Do not run the manual mount and the systemd service at the same time for `~/GDrive`.

---

## 9. Configure gsynchro

Example `.gsynchro/gsynchro.yml`:

```yaml
destination: /home/alex/GDrive/projects/my-project

debounce: 5

items:
  - "*.md"
  - "docs/**/*.md"
  - "stack/**/*.md"
  - "tasks/**/*.md"
  - "usecases/**/*.md"
```

The rclone mount must be available before starting:

```bash
npm run gsynchro
```

---

## 10. GNOME Online Accounts

If Google Drive is already configured through GNOME Online Accounts, do not use its **Files** integration as the `gsynchro` destination. It can be disabled to avoid a second, misleading view of the same Drive; rclone remains the mount used by `gsynchro`.

Typical path:

```text
Settings
→ Online Accounts
→ Google
→ Files: OFF
```

Other Google services can remain enabled.

---

## 11. Useful rclone commands

List directories:

```bash
rclone lsd gdrive:
```

List contents:

```bash
rclone lsf gdrive:
```

Copy without deleting files from the destination:

```bash
rclone copy source gdrive:destination
```

Synchronize the destination to match the source:

```bash
rclone sync source gdrive:destination
```

> Warning: `sync` can delete files from the destination.

Do not run `rclone copy` or `rclone sync` against the same project directory while `gsynchro` is running. They bypass `gsynchro`'s selected-file filters, synchronization state, conflict rule, and trash recovery.

During testing, prefer:

```bash
rclone sync --interactive source gdrive:destination
```

Show the configuration:

```bash
rclone config show
```

> Warning: this output can contain OAuth refresh tokens and client credentials. Do not paste it into an issue, chat, log, or public document.

Show the paths used by rclone:

```bash
rclone config paths
```

Verify the remote:

```bash
rclone about gdrive:
```

---

## Architecture

```text
Google Drive
    ↕
  rclone
    ↕
 ~/GDrive
    ↕
 gsynchro
    ↕
Git repository
```

`rclone` is responsible only for connecting Google Drive to the local filesystem.

`gsynchro` is responsible only for the selective, bidirectional synchronization between the repository and the folder mounted at `~/GDrive`.

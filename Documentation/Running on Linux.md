OSINT Copilot ships for Linux as an **AppImage** (portable, no install) and a **.deb**. Both
are built from the same code; pick whichever suits you.

Downloads live at
[osint-copilot-releases](https://github.com/OSINT-Copilot/osint-copilot-releases/releases).

# Running the AppImage

```bash
chmod +x osint-copilot-0.14.0-x86_64.AppImage
./osint-copilot-0.14.0-x86_64.AppImage --ozone-platform=x11
```

That is the whole thing on most machines. The rest of this page is what to do when it is not.

On **Ubuntu 24.04 and later** it is not: the app aborts before any window appears, with
"The SUID sandbox helper binary was found, but is not configured correctly". That section
below has three ways out, and installing the .deb instead is the shortest of them.

## Why `--ozone-platform=x11`

Electron's Wayland backend segfaults the instant it creates a renderer on some systems --
including kernel 7.x with Electron 42. There is no error; the window simply never appears.
Forcing the X11 backend avoids it, and X11 apps run fine under Wayland through XWayland.

The flag *is* baked into the `.desktop` entry, so launching from an application menu after
integrating the AppImage does not need it. Running the file directly from a terminal
bypasses that entry, which is why you pass it by hand.

If your system runs Electron happily under Wayland, you can leave the flag off.

## "Cannot mount AppImage, please check your FUSE setup"

AppImages mount themselves with FUSE. Where FUSE 2 is missing -- common on newer
distributions, which ship FUSE 3 -- unpack and run instead:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./osint-copilot-0.14.0-x86_64.AppImage --ozone-platform=x11
```

The equivalent `--appimage-extract-and-run` flag also works. Neither appears in
`--appimage-help`, which lists only a subset of what the runtime supports; both are in it.

That unpacks to a temporary directory and runs from there. It is slower to start and needs
no system changes. The alternative is installing `libfuse2` from your distribution.

## "The SUID sandbox helper binary was found, but is not configured correctly"

In full:

```
FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox helper
binary was found, but is not configured correctly. Rather than run without sandboxing
I'm aborting now. You need to make sure that /tmp/.mount_osint-XXXXXX/chrome-sandbox
is owned by root and has mode 4755.
```

Ubuntu 24.04 and later set `kernel.apparmor_restrict_unprivileged_userns=1`, which stops an
unconfined program opening the user namespace Chromium's sandbox normally uses. Chromium
then looks for its setuid helper instead, and inside an AppImage that helper can never
work: an AppImage mounts itself with `nosuid`, where the setuid bit is ignored.

**Running `chmod 4755` on the `.AppImage` file does not help.** The path in the message is
a file inside that temporary mount, not the file you ran, and the mount is read-only.

Three ways out, in the order worth trying.

### Install the .deb instead

It carries an AppArmor profile that grants the app the user namespace, and the installer
puts the sandbox helper in the right state. Nothing else to do, and the sandbox stays on.

### Allow the user namespace

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

To make that survive a reboot, put `kernel.apparmor_restrict_unprivileged_userns=0` in
`/etc/sysctl.d/60-apparmor-namespace.conf`. This applies to every program on the machine,
which is the trade: one setting relaxed for everything, and the app's own sandbox intact.

### Unpack the AppImage and give the helper its bit

Nothing changes system-wide, and the unpacked copy sits on your own filesystem, where the
setuid bit is honoured:

```bash
./osint-copilot-0.14.0-x86_64.AppImage --appimage-extract
sudo chown root:root squashfs-root/chrome-sandbox
sudo chmod 4755 squashfs-root/chrome-sandbox
./squashfs-root/osint-copilot --ozone-platform=x11
```

Run `squashfs-root/osint-copilot`, not `squashfs-root/AppRun`. AppRun expects the variables
the AppImage runtime sets, and without them exits with `/osint-copilot: No such file or
directory`.

### Or `--no-sandbox`

It starts, but think twice: this app renders model output, enricher responses and captured
web pages, none of which it wrote. The renderer sandbox is worth having.

## No window, and no error at all

Check that `ELECTRON_RUN_AS_NODE` is not exported in your shell:

```bash
echo "$ELECTRON_RUN_AS_NODE"
```

If it prints anything, the Electron binary is running as plain Node: no window opens,
`electron --version` prints a Node version, and nothing explains why. `unset
ELECTRON_RUN_AS_NODE` and try again.

# Running the .deb

The route that needs no setup: it handles the sandbox and the X11 flag for you.

```bash
sudo apt install ./osint-copilot_0.14.0_amd64.deb
```

It installs to `/opt/OSINT Copilot`, installs an AppArmor profile so the Chromium sandbox
works without relaxing anything system-wide, and adds a menu entry that already carries the
X11 flag. To run it from a terminal:

```bash
"/opt/OSINT Copilot/osint-copilot" --ozone-platform=x11
```

# Building your own

```bash
git submodule init && git submodule update
npm ci                                  # repository root
npm run build                           # repository root
cd apps/tangent-electron && npm run start
```

`npm run start` goes through `scripts/launch.mjs`, which handles all three problems above
for you -- it strips `ELECTRON_RUN_AS_NODE`, defaults to X11 on Linux, and falls back to
`--no-sandbox` with a loud warning if the sandbox is blocked. Use it while developing.

`npm run dev` rebuilds as you edit, but does **not** go through that launcher, so pass the
flag yourself: `npm run dev -- --ozone-platform=x11`.

If the build is killed part-way, it ran out of memory. Give it more:

```bash
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

To produce your own installers without publishing anything:

```bash
cd apps/tangent-electron && npm run package:linux
```

The results land in `apps/tangent-electron/dist/`.

# First run

The app asks for a licence key before it opens a workspace. Paste the key from your
account on the dashboard; a subscription key and an offline `OSINT-...` key are both
accepted from 0.13.0 onward.

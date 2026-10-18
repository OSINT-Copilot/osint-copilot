OSINT Copilot ships for Windows as an **installer** and a **portable .exe**. Both are built
from the same code and both carry x64 and arm64, so one file covers either machine.

Downloads live at
[osint-copilot-releases](https://github.com/OSINT-Copilot/osint-copilot-releases/releases).

Windows 10 or later. Nothing else has to be installed -- no runtime, no Visual C++
redistributable, no WebView2.

# "Windows protected your PC"

This is the first thing you will see, and it is expected.

These builds are **not code-signed yet**. Without a signature SmartScreen shows a blue box
saying it "prevented an unrecognised app from starting". Choose **More info**, then **Run
anyway**.

The warning is about the missing signature and nothing else: SmartScreen cannot tell an
unsigned application it has never seen from a malicious one, so it warns about both. It will
stop once the build is signed with a certificate that has a download reputation.

If you would rather check the file yourself first, compare the checksum GitHub shows beside
it on the release page with the one `Get-FileHash` prints for your download:

```powershell
Get-FileHash 'OSINT-Copilot-Setup-0.14.7.exe'
```

# The installer

`OSINT-Copilot-Setup-0.14.7.exe` walks through a normal setup and lets you choose the folder.
By default it installs into your own profile (`%LOCALAPPDATA%\Programs\OSINT Copilot`), which
needs no administrator rights.

It adds a Start menu entry, and registers OSINT Copilot as one of the applications Windows
offers for `.md` and `.mdx` files and for images -- offers, not takes: your existing default
is untouched.

# The portable build

`OSINT-Copilot-Portable-0.14.7.exe` runs straight from the file. Nothing is installed, no
Start menu entry is added and no file types are registered, which makes it the one to use from
a USB stick or on a machine you cannot install software on.

It unpacks itself to a temporary folder on each start, so it starts more slowly than the
installed build. Your data does **not** live in that folder -- see below -- so deleting the
`.exe` is the whole uninstall.

# Where your data is

Two places, and neither is inside the application:

* `%APPDATA%\OSINT Copilot` -- the licence key, the list of workspaces, window layout, and the
  browser extension's pairing.
* Your investigations, which are ordinary folders wherever you made them.

Uninstalling leaves both alone. To start completely fresh, delete the first one; you will have
to enter the licence key and pair the extension again.

```powershell
Remove-Item -Recurse "$env:APPDATA\OSINT Copilot"
```

# Uninstalling

Settings -> Apps -> Installed apps -> OSINT Copilot -> Uninstall, or run
`Uninstall OSINT Copilot.exe` from the install folder. For the portable build, delete the
`.exe`.

# First run

The app asks for a licence key before it opens a workspace. Paste the key from your account on
the dashboard; a subscription key and an offline `OSINT-...` key are both accepted.

The key is checked on your own machine against a public key compiled into the build, so it
works with no network connection, and nothing about your licence is sent anywhere.

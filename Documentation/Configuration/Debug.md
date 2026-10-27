The debug options are intended for troubleshooting and normally appear only in preview or
source builds. Changing them can break application behavior.

Automatic crash reporting is disabled. OSINT Copilot does not start Electron's network crash
reporter or upload crash dumps, so there is no crash-upload control on this page.

Disabling **Links Can Create Virtual Files** prevents OSINT Copilot from indexing [[Wiki Links]]
to files that do not exist yet. This can break features that rely on unresolved links and should
be used only while troubleshooting.

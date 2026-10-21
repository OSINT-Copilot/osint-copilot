OSINT Copilot is a local-first investigation workspace built on the Tangent note editor. It reads and edits [[Markdown Syntax|Markdown]] files within a local [[The Workspace|workspace]] and creates an index of the [[Wiki Links]] between notes.

You can follow links by Control/Command clicking on them.

OSINT Copilot is a cross-platform application. Mac and Windows have different shortcut conventions, and this documentation uses `Cmd/Ctrl` as a shorthand way of directing you to use the Command key on a Mac and the Control key on a machine running Windows.

# Core Concepts
OSINT Copilot operates on a [[The Workspace|Workspace]], a local folder of files on your computer. You can see the notes and folders within that folder in [[The Sidebar]].

Double bracket [[Wiki Links]] are the heart of OSINT Copilot. They let you easily connect different thoughts together. Notes are aware that other notes link to them; you can see all incoming links in a note's [[Backlinks]].

The default view of your notes is the [[Thread View]]. As you follow links, the linked notes stack up to the right in a series of sliding panels. If you want to focus on just one note without loosing the context of the Thread, you can use one of the [[Focus Modes]] to zero in on a particular note. If you need a larger view of your thoughts, OSINT Copilot builds a [[Map View]] as you add and follow links in your workspace.

The [[Command Palette]] lets you search for notes (`Cmd/Ctrl+O`) and actions you can take on notes without (`Cmd/Ctrl+P`) needing to take your hands off of your keyboard.

# Note-Writing Foundation

The editor inherited from [Tangent](https://github.com/suchnsuch/Tangent) was designed around
[Wikilogging](https://everything-abridged.com/wikilogging), a free-form practice in which daily
and transient notes lead into interconnected, longer-lived notes.

OSINT Copilot implements daily logs through [[Creation Rules]]. A typical workflow starts with
the **Daily Note** action in the [[Command Palette]]. As a concrete subject appears, create a
[[Wiki Links|wiki link]] for it, follow that link into the [[Thread View]], and write or update
the connected note. This can nest into a chain of notes; move back through the thread when you
want to follow another line of thought.

The [[Map View]] provides a bird's-eye view of recent note threads and can work as a scratch
pad. Remove old threads from the map when they are no longer useful there; doing so does not
delete the notes.

This inherited workflow is optional. You can use folders, links, or the OSINT-specific entity,
graph, timeline, locations, and canvas views in whatever combination suits the investigation.
Questions and suggestions are welcome through [[Feedback]].

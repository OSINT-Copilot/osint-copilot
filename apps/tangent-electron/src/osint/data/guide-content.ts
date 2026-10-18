/**
 * The in-app guide: one source of truth for both the Guide view and the welcome dialog.
 *
 * Markdown rather than built DOM, so the text stays editable by anyone who can write a
 * note, and so the Guide view can hand it straight to the same MarkdownRenderer the chat
 * transcript uses. Kept in `data/` beside the other seeded defaults for the same reason
 * they are: it is content, not behaviour.
 *
 * Paths quoted below are the defaults from constants/vault-layout.ts and are interpolated
 * rather than retyped, so a folder rename cannot leave the documentation lying.
 */
import {
    DEFAULT_CANVAS_FOLDER,
    DEFAULT_CONVERSATION_FOLDER,
    DEFAULT_ENRICHERS_FOLDER,
    DEFAULT_SKILLS_FOLDER,
    DEFAULT_TASK_AGENTS_FOLDER,
    OSINT_COPILOT_VAULT_ROOT,
} from '../constants/vault-layout';

export interface GuideSection {
    /** Anchor id, used by the view's contents rail. */
    id: string;
    title: string;
    /** lucide-static icon name, kebab-case. */
    icon: string;
    /** Markdown body, rendered with the shim's MarkdownRenderer. */
    body: string;
}

/**
 * The welcome dialog shows the first three sections; the Guide view shows all of them.
 * Order is the reading order in both places.
 */
export const GUIDE_SECTIONS: readonly GuideSection[] = [
    {
        id: 'what-this-is',
        title: 'What OSINT Copilot is',
        icon: 'compass',
        body: `
OSINT Copilot is an investigation workspace built on plain markdown files. Everything you
collect — entities, relationships, events, locations, notes — is a file in your vault that
you can read, edit, grep and put under version control. Nothing is locked in a database.

An AI assistant works **alongside** those files rather than owning them. It reads your
notes, proposes changes, and every change it proposes is shown to you as a diff before
anything is written.

Your vault lives wherever you chose when you opened it. OSINT Copilot keeps its own
material under \`${OSINT_COPILOT_VAULT_ROOT}/\`.
`.trim(),
    },
    {
        id: 'the-views',
        title: 'The views',
        icon: 'layout-grid',
        body: `
The button group in the top bar switches between the views. Each one is a different lens
onto the same entities — add a person in one and it is there in the others.

| Shortcut | View | What it is for |
| --- | --- | --- |
| \`Ctrl+Alt+1\` | **Chat** | Ask questions about the vault, and let the assistant work in it |
| \`Ctrl+Alt+2\` | **Entities** | Who and what, and how they connect |
| \`Ctrl+Alt+3\` | **Timeline** | The same entities, ordered by when they happened |
| \`Ctrl+Alt+4\` | **Locations** | Everything with coordinates, on a map |
| \`Ctrl+Alt+5\` | **Tools & Skills** | The skills and enrichers the assistant can call |
| \`Ctrl+Alt+6\` | **Guide** | This guide |
| \`Ctrl+Alt+7\` | **Canvas** | Freeform boards for laying a case out by hand |

The shortcut digit is the button's position in the bar, so they can be learned left to
right. You can reassign them under **Settings → Shortcuts**.

Entities, Timeline and Locations are hidden when graph features are turned off in
**Settings → OSINT Copilot**.
`.trim(),
    },
    {
        id: 'first-steps',
        title: 'Getting started',
        icon: 'play',
        body: `
1. **Connect an assistant.** Open **Settings → OSINT Copilot** and choose a runtime —
   Claude Code, Codex CLI or Hermes. Each one is a command-line tool you install
   separately; OSINT Copilot finds it on your \`PATH\`, or you can give it an explicit
   path. Without one, every view still works, but the Chat view has nothing to answer it.
2. **Open Chat and ask something.** "What is in this vault?" is a fine first question.
   Answers cite the notes they came from, and the citations are clickable.
3. **Create your first entity.** In the Entity graph, use **+ Add entity**. Pick a type —
   Person, Organisation, Location, Event and the rest follow the
   [FollowTheMoney](https://followthemoney.tech) schema — and give it a name.
4. **Connect two entities.** Select one, shift-click another, and use **Connect**. The
   relationship is written to both notes.
5. **Watch it appear elsewhere.** An entity with a date shows up on the Timeline; one with
   coordinates shows up on the Map.
`.trim(),
    },
    {
        id: 'chat',
        title: 'Working with the assistant',
        icon: 'message-square',
        body: `
The Chat view is where the assistant does work. It can read every note in the vault, and
it can propose writing to it.

- **Nothing is written without your approval.** A proposed change arrives as a diff with
  **Apply** and **Discard**. Read it before applying.
- **Paste a URL** on its own and the page is fetched and extracted into the conversation
  before your question is sent.
- **Drop files** onto the transcript to attach them.
- Conversations are saved as notes under \`${DEFAULT_CONVERSATION_FOLDER}/\`, so you can
  search them like anything else.

The assistant is a research aid, not a source. Treat what it produces the way you would
treat a tip from a colleague: worth following up, not worth publishing unchecked.
`.trim(),
    },
    {
        id: 'boards',
        title: 'Canvas boards',
        icon: 'layout-dashboard',
        body: `
A board is a freeform surface: drag notes, images and link cards around, and draw
connections between them. Use it when the shape of a case is still a question rather than
a structure — the graph is generated from your data, but a board is arranged by you.

Boards are \`.canvas\` files under \`${DEFAULT_CANVAS_FOLDER}/\`, in the same
[JSON Canvas](https://jsoncanvas.org) format Obsidian uses, so the same file opens in
either application.

The **Canvas** button in the top bar lists the boards you already have and offers a new
one. There can be as many as you like.
`.trim(),
    },
    {
        id: 'extending',
        title: 'Skills, enrichers and agents',
        icon: 'layout-list',
        body: `
The **Tools & Skills** view is the registry of everything the assistant can call beyond
reading and writing notes.

- **Skills** are markdown instructions that teach the assistant a procedure — how you like
  a subject profile written, say. They live in \`${DEFAULT_SKILLS_FOLDER}/\`.
- **Enrichers** are HTTP lookups against an external service, defined as JSON with an
  explicit domain allowlist. They live in \`${DEFAULT_ENRICHERS_FOLDER}/\`. An enricher
  starts as a draft and does nothing until you set it active.
- **Task agents** are longer-running jobs with their own output allowlist, so an agent can
  only write where you have said it may. They live in \`${DEFAULT_TASK_AGENTS_FOLDER}/\`.

All three are plain files. Editing one in the editor is the supported way to change it.
`.trim(),
    },
    {
        id: 'safety',
        title: 'Handling untrusted material',
        icon: 'shield',
        body: `
OSINT work means opening things written by people who would rather you did not.

- **Content you collect can try to instruct the assistant.** A page or document can carry
  text aimed at the model rather than at you. This is why proposed changes are always shown
  as a diff — read what is being written, not just the summary of it.
- **Enricher domain allowlists are the boundary** for what leaves your machine. Check the
  allowlist before activating one.
- **Credentials stored in the vault are stored in plain text.** If that is not acceptable
  for a given key, do not put it there.
- The vault is yours and local. Nothing is uploaded anywhere except by a runtime or an
  enricher you configured.
`.trim(),
    },
    {
        id: 'keys',
        title: 'Keyboard shortcuts',
        icon: 'keyboard',
        body: `
| Shortcut | Action |
| --- | --- |
| \`Ctrl+Alt+1\` … \`Ctrl+Alt+7\` | Switch to a view, left to right along the bar |
| \`Ctrl+P\` | Command palette — every command in the app |
| \`Ctrl+O\` | Quick open a note by name |
| \`Ctrl+,\` | Settings |
| \`Escape\` | Close the topmost dialog |

Every shortcut, including the view ones, can be reassigned under **Settings → Shortcuts**.
On macOS, use \`Cmd\` where the table says \`Ctrl\`.
`.trim(),
    },
];

/** The sections the first-run dialog shows, in order. */
export const WELCOME_SECTION_IDS = ['what-this-is', 'the-views', 'first-steps'] as const;

export function guideSection(id: string): GuideSection | undefined {
    return GUIDE_SECTIONS.find((section) => section.id === id);
}

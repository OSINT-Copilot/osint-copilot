<script lang="ts">
import type { Workspace } from 'app/model'
import { getContext } from 'svelte'

const workspace: Workspace = getContext('workspace')

function openDocumentation() {
	workspace.api.documentation.open('Getting Started')
}
</script>

<main>
	<p class="logo">
		
	</p>
	<p class="version">v{workspace.version}</p>
	<p>
		<span class="product">OSINT Copilot</span> is an investigation workspace for open-source
		research, made by
		<a target="_blank" rel="noreferrer" href="https://github.com/OSINT-Copilot">Probe Point Analytics</a>.
		Everything it records is a plain markdown file in a folder you control.
	</p>
	<p>
		<!-- svelte-ignore a11y-invalid-attribute -->
		Take a look at <a href="#" on:click={openDocumentation} class="local">the documentation</a> if you
		have a question. Downloads and release notes are on the
		<a target="_blank" rel="noreferrer" href="https://github.com/OSINT-Copilot/osint-copilot-releases/releases">releases page</a>.
	</p>
	<p class="credit">
		Built on <a target="_blank" rel="noreferrer" href="https://www.tangentnotes.com">OSINT Copilot</a>
		by <a target="_blank" rel="noreferrer" href="http://tangentnotes.com/About">Taylor Hadden</a>,
		used under the Apache License 2.0. The editor, file tree, link index and query language are
		OSINT Copilot's; the investigation toolset is ours. Please send questions about OSINT Copilot to us
		rather than to Tangent.
	</p>
	<h1>OSINT Copilot's supporters</h1>
	<p style:margin-bottom="0">
		These people made exceptional contributions to Tangent, which this application is built on:
	</p>
	<ul>
		<li>Trevor Slaton</li>
		<li>Paul Williams</li>
		<li>Dormouse</li>
		<li>Jose Quesada</li>
		<li>Ethan LP</li>
	</ul>
</main>

<style lang="scss">
.product {
	color: var(--accentTextColor);
}

.credit {
	color: var(--deemphasizedTextColor);
	font-size: 92%;
}

main {
	padding: 0 2em;
	font-size: 90%;
}

.logo {
	background-image: url('tangent-icon.svg');
	background-repeat: no-repeat;
	background-position: center;
	height: 8em;
}

.version {
	text-align: center;
	color: var(--deemphasizedTextColor);
	font-style: italic;
}

ul {
	column-count: 2;
}
</style>

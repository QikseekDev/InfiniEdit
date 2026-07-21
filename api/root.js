const MARKDOWN = `# InfiniEdit

Browser-based save editor for the game Infinite Craft. Single-page, client-side only, no backend for core functionality. Unofficial fan project, not affiliated with Infinite Craft or its creators.

## Summary

InfiniEdit lets a user open an Infinite Craft \`.ic\` save file, edit elements and recipes, analyze the save (duplicates, dead ends, missing dependencies), visualize the recipe dependency tree as a graph, and export the result. All processing happens in the browser; no save data is uploaded to any server. It also exposes its editing actions as WebMCP tools so an in-browser AI agent can operate on the loaded save directly.

## Live instances

- Primary: https://infiniedit.qzz.io
- Mirror: https://infiniedit.vercel.app
- Source: https://github.com/QikSeekDev/InfiniEdit

## Tech stack

- Vanilla HTML5 / CSS3 / JavaScript, single file (\`index.html\`), no frameworks, no build step, no bundler, no npm dependencies for the client app.
- No analytics, no tracking, no accounts, no server-side storage of user data.

## Data model

- Input/output format: \`.ic\` save files (Infinite Craft's native save format) and JSON export.
- Elements: id, name, emoji, discovery flag.
- Recipes: pairs of ingredient element ids mapping to a result element id, stored per-element.

## Local persistence

Browser \`localStorage\` keys used:

| Key purpose | Behavior |
|---|---|
| Autosave | Current save state, written on \`beforeunload\` and periodically. |
| Backups | Rolling list of prior save snapshots for manual restore. |
| Theme | \`dark\` or \`light\`, persisted across sessions. |
| Low-end mode | Boolean flag; disables the dependency graph panel for low-power devices. |

No IndexedDB, no cookies, no server-side sessions.

## External network calls

InfiniEdit makes outbound requests only for live recipe/autocomplete lookups against third-party services, proxied through a CORS proxy where needed:

- Recipe lookup: \`https://infinibrowser.wiki/api/Recipe?id={name}\` (via CORS proxy)
- "Used in" lookup (paginated): \`https://infinibrowser.wiki/api/uses/?id={name}&offset={n}\` (via CORS proxy)
- Autocomplete search: \`https://infinibrowser-ws-test.vercel.app/api/search?id={query}\`
- CORS proxy: \`https://cors.qikseek.qzz.io/?url={encoded target}\`, response wrapped as \`{"contents": "..."}\` requiring an inner \`JSON.parse\`.

These calls are used for: autocomplete when adding elements, auto-fetching missing recipes, bulk-filling missing recipes, and the inspector panel's "used in" data. They are optional/lazy — the editor is fully functional offline for save editing without them.

## Feature list

- Save management: open/export \`.ic\`, export JSON, drag & drop, autosave, backup manager, merge saves, compare saves.
- Element editor: browse, search, filter, multi-column sort, add/rename/delete elements, edit emoji, multi-select bulk editing, live autocomplete.
- Recipe editor: create/edit/delete recipes, import recipe lists, search, missing-ingredient detection, auto-fetch from InfiniBrowser API, bulk-fill missing recipes.
- Analysis: duplicate detection, exact-duplicate dedupe (merges elements with identical name/emoji/symbols, repoints their recipes, with confirmation and undo), dead-end detection, reachability analysis, missing-dependency detection, ingredient statistics, discovery tracking.
- Dependency graph: interactive visualization, zoom/pan, re-layout, relationship highlighting, toggle labels/emojis, center-on-node. Disabled in low-end mode.
- General: undo/redo, dark/light theme, responsive/mobile layout, resizable panels, toast notifications.
- AI agent tools: exposes editor actions via WebMCP for in-browser AI agents (see below).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl/Cmd + O | Open file |
| Ctrl/Cmd + S | Export \`.ic\` |
| Ctrl/Cmd + Z | Undo |
| Ctrl/Cmd + Y or Ctrl/Cmd + Shift + Z | Redo |
| Delete | Delete selected element |
| F2 | Rename selected element |

Shortcuts are suppressed while focus is in an input, textarea, or contenteditable element.

## WebMCP tools

When the browser supports WebMCP (\`document.modelContext\`, falling back to the legacy \`navigator.modelContext\` alias), InfiniEdit registers tools an AI agent can call against the currently loaded save. Spec: https://webmachinelearning.github.io/webmcp/

| Tool | Read-only | Description |
|---|---|---|
| \`get_save_summary\` | Yes | Save name, element count, recipe count, discovered count. Call this first. |
| \`search_elements\` | Yes | Substring search over element names; returns id, name, emoji. |
| \`get_element\` | Yes | Full details for one element: its recipes and what uses it as an ingredient. |
| \`add_element\` | No | Adds a new element (name, emoji, optional first-discovery flag). Does not fetch recipe data. |
| \`add_recipe\` | No | Adds a recipe linking two existing ingredients to an existing result element. |
| \`delete_element\` | No | Deletes an element by name or id and removes recipes referencing it. Destructive — agents are instructed to confirm with the user first. |
| \`analyze_save\` | Yes | Runs the analyzer; returns counts of duplicate recipes, dead ends, unreachable elements, and missing dependencies. |
| \`export_save\` | No | Triggers a browser download of the current save as \`.ic\`. |

Elements can be referenced by name (case-insensitive, exact match preferred, falling back to substring match) or by numeric id in tool inputs.

## API / content negotiation

\`GET /\` normally serves \`index.html\`. If the request's \`Accept\` header contains \`text/markdown\`, a Cloudflare URL Rewrite Rule internally rewrites the request to \`/api/root\` (the URL bar/visible URL does not change), which returns this document as \`text/markdown\`.

\`/api/root\` also sets \`Vary: Accept\` and, when reached directly, the same content-negotiation headers as \`/\`.

## Privacy

No save data, element data, or recipe data leaves the user's device except for the optional outbound lookups described above, which send only element names (not full save contents) to third-party APIs. WebMCP tools operate purely on in-memory state already loaded in the browser and make no additional network calls themselves.

## License / contribution

Open source. Issues and pull requests accepted via GitHub. No CLA or contribution restrictions documented beyond standard GitHub workflow.
`;

const ETAG = `"${Buffer.byteLength(MARKDOWN).toString(16)}-${MARKDOWN.length}"`;

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).send('Method Not Allowed');
    return;
  }

  // Conditional GET support
  if (req.headers['if-none-match'] === ETAG) {
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  res.setHeader('ETag', ETAG);
  res.setHeader('Vary', 'Accept');

  if (req.method === 'HEAD') {
    res.status(200).end();
    return;
  }

  res.status(200).send(MARKDOWN);
}

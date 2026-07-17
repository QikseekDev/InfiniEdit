const MARKDOWN = `# InfiniEdit

Browser-based save editor for the game Infinite Craft. Single-page, client-side only, no backend for core functionality. Unofficial fan project, not affiliated with Infinite Craft or its creators.

## Summary

InfiniEdit lets a user open an Infinite Craft \`.ic\` save file, edit elements and recipes, analyze the save (duplicates, dead ends, missing dependencies), visualize the recipe dependency tree as a graph, and export the result. All processing happens in the browser; no save data is uploaded to any server.

## Live instances

- Primary: https://infiniedit.qzz.io
- Mirror: https://infiniedit.vercel.app
- Source: https://github.com/QikSeekDev/InfiniEdit

## Tech stack

- Vanilla HTML5 / CSS3 / JavaScript, single file (\`index.html\`), no frameworks, no build step, no bundler, no npm dependencies for the client app.
- No analytics, no tracking, no accounts, no server-side storage of user data.

## Data model

- Input/output format: \`.ic\` save files (Infinite Craft's native save format) and JSON export.
- Elements: name, emoji, discovered flag.
- Recipes: pairs of ingredient element IDs mapping to a result element ID.

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

InfiniEdit makes outbound requests only for live recipe lookups against the third-party InfiniBrowser API, proxied through a CORS proxy:

- Recipe lookup: \`https://infinibrowser.wiki/api/Recipe?id={name}\`
- "Used in" lookup (paginated): \`https://infinibrowser.wiki/api/uses/?id={name}&offset={n}\`
- Proxy: \`https://cors.qikseek.qzz.io/?url={encoded target}\`, response wrapped as \`{"contents": "..."}\` requiring an inner \`JSON.parse\`.

These calls are used for: autocomplete when adding elements, auto-fetching missing recipes, bulk-filling missing recipes, and the inspector panel's "used in" data. They are optional/lazy — the editor is fully functional offline for save editing without them.

## Feature list

- Save management: open/export \`.ic\`, export JSON, drag & drop, autosave, backup manager, merge saves, compare saves.
- Element editor: browse, search, filter, multi-column sort, add/rename/delete elements, edit emoji, multi-select bulk editing, live autocomplete via InfiniBrowser.
- Recipe editor: create/edit/delete recipes, import recipe lists, search, missing-ingredient detection, auto-fetch from InfiniBrowser API, bulk-fill missing recipes.
- Analysis: duplicate detection, dead-end detection, reachability analysis, missing-dependency detection, ingredient statistics, discovery tracking.
- Dependency graph: interactive visualization, zoom/pan, re-layout, relationship highlighting, toggle labels/emojis, center-on-node. Disabled in low-end mode.
- General: undo/redo, dark/light theme, responsive/mobile layout, resizable panels, toast notifications.

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

## API / content negotiation

\`GET /\` normally serves \`index.html\`. If the request's \`Accept\` header contains \`text/markdown\`, a Cloudflare URL Rewrite Rule internally rewrites the request to \`/api/root\` (the URL bar/visible URL does not change), which returns this document as \`text/markdown\`.

\`/api/root\` also sets \`Vary: Accept\` and, when reached directly, the same content-negotiation headers as \`/\`.

## Privacy

No save data, element data, or recipe data leaves the user's device except for the optional outbound lookups described above, which send only element names (not full save contents) to the InfiniBrowser API.

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

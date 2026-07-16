# Evidence Document: Export-Deck Follow-up Acceptance

This document provides evidence of the implementation and correctness for the `export-deck` module refactoring, emoji truncation boundary test, and regression consistency test.

---

## 1. `naming.ts` Migration Consolidation & Verification

The newly created [naming.ts](file:///C:/Users/Owner/Documents/GitHub/wt-export-deck-followup/server/modules/export-deck/naming.ts) consolidates shared file utility and name generation functions. Below is the list of consolidated functions, their source paths, and a verification of semantic equivalence:

| Function Name | Original Locations | Semantic Equivalence / Diff Analysis |
| :--- | :--- | :--- |
| `isReadableFile` | `routes.ts:27-36`<br>`generator.ts:38-47` | **Identical**: Both check file existence, verify that the path is a file (using `fs.statSync`), and ensure read accessibility (via `fs.accessSync`). |
| `getLocalPath` | `routes.ts:49-67`<br>`generator.ts:53-70` | **Identical**: Both ensure a URL of the format `/uploads/...` is validated, resolving to a local path within `uploadsDir` while protecting against directory traversal. |
| `sanitizeFilename` | `routes.ts:41-43`<br>`generator.ts:75-77` | **Identical**: Both use the regex `/[^\p{L}\p{N}_\-]/gu` to replace characters other than letters, numbers, underscores, and hyphens with underscores. |
| `sceneExportFile` | `routes.ts:399-414`<br>`generator.ts:803-817` | **Consolidated**: Extracts the scene name generation and file resolution logic to a single source of truth. Both original routes and generator files now use this function to get `{ fileName, localPath }`. |

---

## 2. Emoji ZWJ Sequence & Truncation Tracing

To test role name truncation on the emoji/surrogate pair boundary properly, the mock project fixture in [routes.test.ts](file:///C:/Users/Owner/Documents/GitHub/wt-export-deck-followup/server/modules/export-deck/routes.test.ts) was updated.

### Truncation Fixture Role:
`role: 'abcdefghijklm' + '🦸‍♂️' + '👑'`

### Array.from() Code Point List & Index Mapping:
1. `[0]` - `'a'` (1)
2. `[1]` - `'b'` (2)
3. `[2]` - `'c'` (3)
4. `[3]` - `'d'` (4)
5. `[4]` - `'e'` (5)
6. `[5]` - `'f'` (6)
7. `[6]` - `'g'` (7)
8. `[7]` - `'h'` (8)
9. `[8]` - `'i'` (9)
10. `[9]` - `'j'` (10)
11. `[10]` - `'k'` (11)
12. `[11]` - `'l'` (12)
13. `[12]` - `'m'` (13)
14. `[13]` - `'🦸'` (14)  *(High & Low Surrogate: `\uD83E\uDDB8` — U+1F9B8)*
15. `[14]` - `'\u200d'` (15) *(ZWJ)*
16. `[15]` - `'♂'` (16)
17. `[16]` - `'\ufe0f'` (17) *(Variation Selector)*
18. `[17]` - `'👑'` (18) *(U+1F451)*

- **Original Length**: `Array.from(role).length === 18` (> 14 threshold).
- **Truncation Boundary**: Truncation limit is 14. Slicing with `chars.slice(0, 14)` takes indices `0` through `13` (inclusive), ending precisely on the first emoji character `'🦸'` (which is a surrogate pair code point). The ZWJ elements are sliced off cleanly.
- **Output**: `abcdefghijklm🦸…`
- **Output Length**: `Array.from(output).length === 15` (14 code points + 1 ellipsis `'…'`).
- **Surrogate Pairs Validity**: The surrogate pair for `'🦸'` is kept intact (high surrogate `\uD83E` immediately followed by low surrogate `\uDDB8`). No isolated surrogates are present.

### Short Role (No Truncation Path Preservation):
`role: '勇者🦸‍♂️👑主角'`
- **Array.from() Length**: `9` (<= 14 limit).
- **Output**: Remains unchanged: `'勇者🦸‍♂️👑主角'`.

---

## 3. Test Runner Outputs & Regression Consistency Checks

All tests in `server/modules/export-deck/` have been run and pass successfully. The regression test validates that:
1. `manifest.scenes[].imageFile` aligns exactly with the actual files generated under `exportDir/scenes/`.
2. Directory naming check asserts that character folders (e.g. `01_角色___Char`) match the shared `sanitizeFilename` logic.

### Test execution command:
`npx tsx --test server/modules/export-deck/routes.test.ts`

### Output snippet:
```
▶ Export Deck Module API and Generator Tests
  ✔ 1. GET delivery-check returns correct statistics and details (1.4501ms)
  ✔ 2. POST export-deck in final mode is blocked with 409 when unfinalized shots exist (0.6538ms)
  ✔ 3. POST export-deck in review mode successfully generates files with fallback and draft labels (45.1835ms)
  ✔ 4. Unicode, scenes, fallback views, and traversal protection in POST export-deck (20.5398ms)
  ✔ 5. Regression consistency test: manifest and zip scenes & characters alignment (13.5476ms)
✔ Export Deck Module API and Generator Tests (99.1318ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 484.4657
```

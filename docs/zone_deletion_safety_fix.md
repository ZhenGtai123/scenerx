# Zone-deletion safety: `activeViewId` validation + friendly fallback

## Problem

When a user deletes a zone (via `DELETE /api/projects/{project_id}/zones/{zone_id}`)
that the frontend's `activeViewId` is currently pointing at via the
`within_zone:<zone_id>` form, the Reports page Baseline banner falls back to
showing the raw deleted zone ID — e.g. `ZONE_1778335346696 (SUB-CLUSTERS) — 1
UNIT` — instead of the proper zone name.

### Bug call chain

1. `packages/frontend/src/pages/Reports.tsx:3078` calls
   `friendlyViewLabel(activeViewId, currentProject?.spatial_zones)`
2. `friendlyViewLabel` (lines 151–165) on the `within_zone:` branch does
   `spatialZones?.find((z) => z.zone_id === zid)?.zone_name || zid` — if the
   zone has been deleted the `find` returns undefined and we fall back to the
   raw zone-id string `zid`.
3. `packages/frontend/src/store/useAppStore.ts:558–560` preserves
   `state.activeViewId` across same-project hydrations, **without checking
   that the zone it references still exists**. This is the root cause: the
   stale within_zone view-id outlives the zone it points at.

## Fix A — `useAppStore.ts` (root cause, prevents the stale id)

**Location**: `packages/frontend/src/store/useAppStore.ts`, replace the block
that currently reads:

```typescript
    const activeViewId = (sameProject && state.activeViewId)
      ? state.activeViewId
      : preservedGroupingMode;
```

with the following block:

```typescript
    // v4.x — Validate that the preserved activeViewId still refers to a live
    // zone. The user may have deleted the zone since the view was set; in
    // that case friendlyViewLabel (Reports.tsx) would fall back to the raw
    // zone_id, which surfaces ugly strings like "ZONE_1778335346696
    // (sub-clusters)" in the Baseline banner. Reset to preservedGroupingMode
    // when the referenced zone no longer exists, matching the
    // sameProject=false branch behavior.
    const candidateViewId = (sameProject && state.activeViewId)
      ? state.activeViewId
      : preservedGroupingMode;
    const activeViewId = (() => {
      if (!candidateViewId.startsWith('within_zone:')) return candidateViewId;
      const zid = candidateViewId.slice('within_zone:'.length);
      const zonesNow = (project.spatial_zones ?? []) as Array<{ zone_id: string }>;
      const stillExists = zonesNow.some((z) => z.zone_id === zid);
      return stillExists ? candidateViewId : preservedGroupingMode;
    })();
```

This is a pure transform of `candidateViewId`; it doesn't introduce any new
state, doesn't mutate the project, and falls through to identical behaviour
in every non-`within_zone:` case.

### Optional follow-up housekeeping (NOT required for the bug fix)

When a zone is removed, stale per-view caches keyed by the deleted zone's id
still sit in:

- `aiReportsByViewId['within_zone:<deleted_id>']`
- `aiReportMetasByViewId['within_zone:<deleted_id>']`
- `designStrategyResultsByViewId['within_zone:<deleted_id>']`
- `analysisViewsByViewId['within_zone:<deleted_id>']`

They are unreachable but consume memory. If you want to GC them, do it in the
hydrate transform right after computing `zonesNow`:

```typescript
const liveIds = new Set(zonesNow.map((z) => z.zone_id));
const dropDead = <T,>(d: Record<string, T>): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(d)) {
    if (!k.startsWith('within_zone:') || liveIds.has(k.slice('within_zone:'.length))) {
      out[k] = v;
    }
  }
  return out;
};
// then use dropDead(...) when populating the *ByViewId fields you set below
```

This is **optional**. The bug fix above (Fix A core) is sufficient on its
own.

## Fix B — `Reports.tsx` (defence in depth, friendlier fallback)

**Location**: `packages/frontend/src/pages/Reports.tsx`, function
`friendlyViewLabel` (lines 151–165). Replace the `within_zone:` branch body:

```typescript
  if (viewId.startsWith('within_zone:')) {
    const zid = viewId.slice('within_zone:'.length);
    const zname = spatialZones?.find((z) => z.zone_id === zid)?.zone_name || zid;
    return `${zname} (sub-clusters)`;
  }
```

with:

```typescript
  if (viewId.startsWith('within_zone:')) {
    const zid = viewId.slice('within_zone:'.length);
    const matched = spatialZones?.find((z) => z.zone_id === zid);
    if (!matched) {
      // v4.x — Defence in depth: Fix A (useAppStore hydrate) is the primary
      // guard, but a within_zone:<deleted_id> can still slip through if the
      // hydrate hasn't fired yet (e.g. mid-mutation render). Surface a clear
      // signal rather than the raw timestamp-ish zone id.
      return 'Deleted zone (sub-clusters)';
    }
    const zname = matched.zone_name || zid;
    return `${zname} (sub-clusters)`;
  }
```

## Coverage matrix — every view option × add/delete zone

After applying Fix A + Fix B, the Baseline banner behavior across every view
type and every user action is:

| `activeViewId`                       | User action          | After fix                                                                          |
| ------------------------------------ | -------------------- | ---------------------------------------------------------------------------------- |
| `zones`                              | Add zone             | Banner shows `Zones`; new zone appears in zone list. ✓                             |
| `zones`                              | Delete zone          | Banner shows `Zones`; deleted zone gone. ✓                                         |
| `clusters`                           | Add/delete zone      | Banner shows `Clusters`; cluster results invalidated by pipeline status. ✓         |
| `parent_zones`                       | Add zone             | Banner shows `Parent zones`; tree includes new zone after re-cluster. ✓            |
| `parent_zones`                       | Delete zone          | Banner shows `Parent zones`; tree drops deleted zone after re-cluster. ✓           |
| `all_sub_clusters`                   | Add/delete zone      | Banner shows `All sub-clusters`; sub-cluster list refreshed after re-cluster. ✓    |
| `within_zone:<live_id>`              | Add unrelated zone   | Banner shows `<zone name> (sub-clusters)` — unaffected. ✓                          |
| `within_zone:<live_id>`              | Delete OTHER zone    | Banner shows `<zone name> (sub-clusters)` — current zone still live. ✓             |
| `within_zone:<live_id>`              | Delete THIS zone     | **Fix A** resets to `preservedGroupingMode` (typically `zones`). Banner shows `Zones`. ✓ |
| `within_zone:<dead_id>` (stale)      | (already stale)      | **Fix A** resets on next hydrate; **Fix B** shows `Deleted zone (sub-clusters)` if hydrate hasn't fired yet. ✓ |

### Why this is enough

- `friendlyViewLabel` only special-cases `within_zone:*`; every other view-id
  is a constant string ('zones' / 'clusters' / 'parent_zones' /
  'all_sub_clusters') with no zone-id dependency, so no add/delete can break
  its label.
- The within_zone path is the only one where the label looks up a zone_id —
  Fix A removes the stale id at the source, Fix B makes the leftover render
  during the in-between frame readable.
- Project switch (`sameProject === false`) is unaffected: `activeViewId`
  goes to `preservedGroupingMode` (defaults to 'zones' on a fresh project,
  see line 428), which has no zone-id reference.

## Manual verification

Reproduce the original bug:

1. Create a project with 3 zones (A, B, C).
2. Run analysis → drill into "within zone B" → confirm Baseline shows
   `<zone B name> (sub-clusters) — N units`.
3. Go back to the project edit page; delete zone B.
4. Navigate back to Reports.

Before the fix: Baseline shows `ZONE_<timestamp> (SUB-CLUSTERS) — N UNITS`.
After Fix A: Baseline shows `Zones — N units` (reset to default).
After Fix B alone (without A): Baseline shows `Deleted zone (sub-clusters) — N units`.

Also verify each row in the coverage matrix above, especially:

- `within_zone:<live_id>` + Delete unrelated zone → banner unchanged.
- `parent_zones` + Delete zone → banner stays `Parent zones`, tree refreshes
  after the re-cluster prompt.

## Notes on landing this patch

- These two edits are independent of the rest of the round-3 changes
  (`Analysis.tsx` / `chart_summary_service.py` / `vision.py` / etc.). If
  reviewer prefers a smaller, single-concern PR, isolate them in a separate
  commit with subject:
  `fix(reports): keep Baseline name correct after zone deletion`.
- No backend changes required. `DELETE /api/projects/{id}/zones/{zid}` already
  cascade-deletes images and invalidates analysis artefacts; the issue was
  purely a stale client-side view-id.
- No test fixture changes required either, but if you add a unit test, the
  smallest reproducer is a `useAppStore.hydrateFromProject(...)` call where
  `state.activeViewId === 'within_zone:gone'` and
  `project.spatial_zones.map(z => z.zone_id)` does not contain `'gone'` —
  expect the post-hydrate `activeViewId` to equal `preservedGroupingMode`.

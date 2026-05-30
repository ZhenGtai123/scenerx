"""
SVC Archetype Clustering Service (GMM-BIC primary; KMeans fallback)

Clusters geo-located image points to discover data-driven spatial archetypes.

Method history:
  - v6.0: KMeans + silhouette-K search
  - v6.1: density-based clustering
  - v6.2 (current): Gaussian Mixture with BIC-selected K is the single primary
    method. Street-view indicator values vary CONTINUOUSLY along a route, so
    the density valleys that density-based methods rely on rarely exist (it kept returning < 2
    clusters and falling back). GMM models the data as a probabilistic mixture
    and BIC selects K with a built-in complexity penalty. See the rationale
    block in cluster().

Pipeline:
  1. Build point × indicator matrix from per-image metrics
  2. Standardise (z-scores)
  3. GMM-BIC fit -> labels + per-K BIC/silhouette diagnostic.
     KMeans + multi-criterion K vote is the numerical-failure fallback.
  4. KNN spatial smoothing (majority vote, optional)
  5. Per-point silhouette coefficient (against final labels) for the
     silhouette-plot chart
  6. Ward hierarchical linkage for the dendrogram chart
  7. Profile + name archetypes (centroid values + z-scores)
  8. Generate segment diagnostics (descriptive, zone_diagnostics-compatible)

Note: the legacy density-clustering outputs (condensed_tree, cluster_persistence,
noise fields) are no longer produced. The dead density-clustering helper methods
and the condensed-tree chart were removed; ClusteringResult may still
carry those fields as empty for backward compatibility.
"""

import logging
from typing import Any

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import fcluster, linkage
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_samples, silhouette_score
from sklearn.mixture import GaussianMixture
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler

from app.models.analysis import (
    ArchetypeProfile,
    ClusteringResult,
    SpatialSegment,
    ZoneDiagnostic,
    IndicatorDefinitionInput,
)

logger = logging.getLogger(__name__)

DEFAULT_MIN_POINTS = 10
DEFAULT_MAX_K = 10
DEFAULT_KNN_K = 7


class ClusteringService:
    """Stateless SVC archetype clustering service (v6.0 descriptive)."""

    def cluster(
        self,
        point_metrics: list[dict],
        indicator_definitions: dict[str, IndicatorDefinitionInput],
        layer: str = "full",
        max_k: int = DEFAULT_MAX_K,
        knn_k: int = DEFAULT_KNN_K,
        min_points: int = DEFAULT_MIN_POINTS,
    ) -> ClusteringResult | None:
        """Run the full clustering pipeline.

        Args:
            point_metrics: List of dicts, each with at least:
                - point_id (str): unique image/point identifier
                - lat, lng (float): coordinates (optional, needed for spatial smoothing)
                - {indicator_id}: float value per indicator
            indicator_definitions: {ind_id: IndicatorDefinitionInput}
            layer: which layer's values to use (default "full")
            max_k: maximum number of clusters to try
            knn_k: k for KNN spatial smoothing
            min_points: minimum usable points required to run clustering

        Returns:
            ClusteringResult or None if insufficient data.
        """
        ind_ids = sorted(indicator_definitions.keys())
        if not ind_ids or len(point_metrics) < min_points:
            logger.info(
                "Clustering skipped: %d points, %d indicators (need >= %d points)",
                len(point_metrics), len(ind_ids), min_points,
            )
            return None

        # 1. Build point x indicator matrix
        df, coords, point_ids = self._build_matrix(point_metrics, ind_ids)
        if len(df) < min_points:
            logger.info(
                "Clustering skipped after matrix build: %d usable rows (need >= %d)",
                len(df), min_points,
            )
            return None

        # 2. Standardise
        scaler = StandardScaler()
        X = scaler.fit_transform(df.values)

        # 3. Cluster-size heuristics (legacy density params). min_cluster_size
        # scales with dataset size — too small fragments into many tiny
        # clusters; too large misses legitimate small archetypes. Heuristic:
        # 5 % of N, clamped to [5, 20].
        n = len(X)

        # ── v6.2 cluster-validity — Hopkins clustering-tendency on the
        # standardised matrix, computed once BEFORE any partition is
        # selected so the pipeline never imposes archetypes on data that
        # has no cluster structure. ──
        hopkins = self._hopkins_statistic(X)

        min_cluster_size = max(5, min(20, int(n * 0.05)))
        min_samples = max(3, min_cluster_size // 2)

        # ─────────────────────────────────────────────────────────────────
        # Single primary method: Gaussian Mixture with BIC-selected K.
        #
        # Rationale:
        #   - Street-view scenes vary CONTINUOUSLY along a route — density-
        #     based clustering assumes density valleys that often
        #     do not exist in this data type.
        #   - GMM models the data as a probabilistic mixture, naturally
        #     handles overlapping / non-spherical clusters.
        #   - BIC (Bayesian Information Criterion) selects K with a built-in
        #     complexity penalty — no arbitrary floor, no silhouette bias.
        #   - Lan et al. 2025 (Heritage Sci. — scenic archetypes) and the
        #     broader landscape-typology literature converge on this choice
        #     for SVI archetype discovery.
        #
        # The K sweep is K=2..max_K_TRY. BIC picks the most parsimonious
        # model that adequately fits the data. If BIC genuinely prefers
        # K=2, that is the honest answer.
        # ─────────────────────────────────────────────────────────────────
        MAX_K_TRY = min(8, n - 1)
        silhouette_scores: list[dict] = []
        persistence: dict[str, float] = {}
        condensed_tree: list[dict] = []
        noise_point_ids: list[str] = []
        noise_mask = np.zeros(n, dtype=bool)

        gmm_k, gmm_sil, gmm_labels, gmm_diagnostic = self._fit_gmm_bic(
            X, k_range=(2, MAX_K_TRY),
        )
        silhouette_scores = gmm_diagnostic  # per-K BIC + silhouette + log-likelihood

        if gmm_labels is not None and gmm_k >= 2:
            labels = gmm_labels
            n_clusters = gmm_k
            hdb_method = (
                f"GaussianMixture (BIC-selected k={gmm_k}, "
                f"silhouette={gmm_sil:.3f}, K-sweep={2}..{MAX_K_TRY})"
            )
        else:
            # GMM had a numerical error (e.g. degenerate covariance). Fall
            # back to KMeans + multi-criterion K vote, no K floor.
            logger.warning("GMM-BIC failed numerically — KMeans multi-criterion fallback")
            best_k, best_score, labels, kmeans_scores = self._find_optimal_k(X, max_k)
            silhouette_scores = kmeans_scores
            n_clusters = best_k
            hdb_method = f"KMeans (GMM-fallback, silhouette-gated k={best_k})"

        # ── v6.2 cluster-validity — Tibshirani gap statistic over the
        # K-sweep, reported as an independent K-validity criterion
        # alongside silhouette / BIC. Diagnostic only: it does NOT
        # override the primary K selection above.
        gap_diagnostic = self._gap_statistic(X, k_range=(2, MAX_K_TRY))

        # Final aggregate silhouette (single number for the badge in UI)
        try:
            agg_silhouette = float(silhouette_score(X, labels))
        except Exception:
            agg_silhouette = 0.0

        # Per-point silhouette for the silhouette-plot chart. Noise points
        # are recorded as None so the chart renders them in a separate strip.
        try:
            per_point = silhouette_samples(X, labels).tolist()
        except Exception:
            per_point = [0.0] * len(labels)
        silhouette_per_point: list[float | None] = [
            None if noise_mask[i] else round(float(per_point[i]), 4)
            for i in range(len(per_point))
        ]

        # 3b. Ward hierarchical linkage powers the dendrogram chart — the
        # cluster tree visual (the former condensed-tree chart was removed).
        try:
            Z_linkage = linkage(X, method="ward", metric="euclidean").tolist()
        except Exception as e:
            logger.warning("Ward linkage failed: %s", e)
            Z_linkage = []

        # 4. KNN spatial smoothing (if coordinates available). Same logic
        # as v6.0 — wipes salt-and-pepper specks but preserves cluster shape.
        has_coords = coords is not None and len(coords) == len(labels)
        # has_FULL_coords = every row has GPS. Spatial smoothing can run over
        # just the GPS-bearing subset (has_coords), but the segment builder,
        # diagnostics, and the lat/lng arrays for the map still require FULL
        # coverage to stay aligned + NaN-free — so they keep the old
        # all-or-nothing contract via has_full_coords.
        has_full_coords = has_coords and bool(np.isfinite(coords).all())
        labels_raw = labels.copy()

        # ── v6.2 cluster-validity — Hennig bootstrap stability of the
        # feature-space partition, measured on the pre-smoothing labels.
        cluster_stability = self._bootstrap_cluster_stability(
            X, labels_raw, n_clusters)

        if has_coords and knn_k > 0 and len(labels) > knn_k:
            labels = self._knn_smooth(coords, labels, knn_k)
            logger.info("KNN smoothing applied (k=%d)", knn_k)

        # 5. Profile archetypes
        archetypes = self._profile_archetypes(df, X, labels, ind_ids, indicator_definitions)

        # 6. Build spatial segments
        segments = self._build_segments(
            df, labels, point_ids, coords if has_full_coords else None, archetypes, ind_ids,
        )

        # 7. Segment diagnostics (descriptive)
        segment_diagnostics = self._build_segment_diagnostics(
            df, X, labels, ind_ids, indicator_definitions,
            archetypes, coords if has_full_coords else None, point_ids,
        )

        point_lats = coords[:, 0].tolist() if has_full_coords else []
        point_lngs = coords[:, 1].tolist() if has_full_coords else []

        method_str = hdb_method
        if has_coords:
            method_str = f"{method_str} + KNN spatial smoothing"

        return ClusteringResult(
            method=method_str,
            k=n_clusters,
            silhouette_score=round(agg_silhouette, 4),
            silhouette_scores=silhouette_scores,  # per-K diagnostic (GMM-BIC sweep or KMeans fallback)
            spatial_smooth_k=knn_k if has_coords else 0,
            layer_used=layer,
            archetype_profiles=archetypes,
            spatial_segments=segments,
            point_ids_ordered=list(point_ids),
            point_lats=point_lats,
            point_lngs=point_lngs,
            labels_raw=[int(x) for x in labels_raw.tolist()],
            labels_smoothed=[int(x) for x in labels.tolist()],
            dendrogram_linkage=Z_linkage,
            cluster_persistence=persistence,
            silhouette_per_point=silhouette_per_point,
            noise_count=int(noise_mask.sum()),
            noise_point_ids=noise_point_ids,
            condensed_tree=condensed_tree,
            hopkins_statistic=round(float(hopkins), 4),
            gap_statistic=gap_diagnostic,
            cluster_stability=cluster_stability,
            cluster_stability_method=(
                "Hennig bootstrap · 100 resamples · KMeans · per-cluster max Jaccard"
            ),
        ), segment_diagnostics

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_matrix(
        point_metrics: list[dict],
        ind_ids: list[str],
    ) -> tuple[pd.DataFrame, np.ndarray | None, list[str]]:
        """Build a (points x indicators) DataFrame + optional coordinate array."""
        rows = []
        coords_list = []
        point_ids = []
        for pm in point_metrics:
            row = {}
            has_any = False
            for ind_id in ind_ids:
                v = pm.get(ind_id)
                if v is not None:
                    row[ind_id] = float(v)
                    has_any = True
            if not has_any:
                continue
            rows.append(row)
            point_ids.append(pm.get("point_id", f"pt_{len(point_ids)}"))
            lat = pm.get("lat")
            lng = pm.get("lng")
            # Append for EVERY kept row (aligned 1:1 with df) — NaN when GPS is
            # missing — so spatial smoothing can run over the GPS-bearing
            # subset instead of being disabled for the whole run when any one
            # image lacks coordinates.
            if lat is not None and lng is not None:
                coords_list.append([float(lat), float(lng)])
            else:
                coords_list.append([float("nan"), float("nan")])

        df = pd.DataFrame(rows, columns=ind_ids).dropna(how="all")
        # v4 polish — defensive NaN handling pipeline. Both KMeans (fallback)
        # and StandardScaler crash hard on residual NaN values, with the
        # very unhelpful "Input X contains NaN" sklearn message. The old
        # `fillna(df.mean())` covers the common case (some images missing
        # one indicator) but FAILS when an entire indicator column is NaN
        # (e.g., a calculator returned None for every image): the column
        # mean is itself NaN, so fillna leaves NaN in place.
        #
        # We do NOT drop the all-NaN columns even though they carry zero
        # signal — `_profile_archetypes` and downstream centroid bookkeeping
        # assume df.columns matches the original ind_ids list. Instead we
        # zero-fill them, which becomes a constant column that StandardScaler
        # turns into more zeros (after subtracting the mean). Net effect:
        # the indicator contributes nothing to the clustering distance,
        # which is the right behaviour when there's no signal.
        all_nan_cols = [c for c in df.columns if df[c].isna().all()]
        if all_nan_cols:
            logger.warning(
                "Indicator columns with no measured values, zero-filling for "
                "clustering: %s", all_nan_cols,
            )
            df[all_nan_cols] = 0.0
        # Per-column mean imputation for the remaining (partial-NaN) cells.
        df = df.fillna(df.mean())
        # Belt-and-suspenders: any cell still NaN (shouldn't happen after the
        # two steps above, but pandas dtype coercion has corner cases) gets
        # zeroed out so we never hand NaN to sklearn.
        if df.isna().values.any():
            stuck = [c for c in df.columns if df[c].isna().any()]
            logger.warning(
                "Residual NaN after mean imputation in columns %s — "
                "filling with 0.0 as a final safety net", stuck,
            )
            df = df.fillna(0.0)

        # coords_list is aligned 1:1 with kept rows (NaN rows where GPS is
        # missing). Expose it when at least one row has valid coordinates;
        # the subset-aware smoother handles the NaN rows, and the full-GPS
        # consumers gate on np.isfinite separately in cluster().
        coords = None
        if coords_list and len(coords_list) == len(df):
            coords_arr = np.array(coords_list, dtype=float)
            if np.isfinite(coords_arr).all(axis=1).any():
                coords = coords_arr

        return df, coords, point_ids[:len(df)]

    @staticmethod
    def _find_optimal_k(
        X: np.ndarray,
        max_k: int,
    ) -> tuple[int, float, np.ndarray, list[dict]]:
        """KMeans K-sweep with silhouette-gated K selection (v6.2).

        Three internal-validity criteria are computed per K:
          - silhouette        (higher = better; the ONLY one of the three
                               with an ABSOLUTE interpretation — >=0.5 strong,
                               0.25-0.5 weak/overlapping, <=0.25 no structure)
          - Davies-Bouldin    (lower = better; RELATIVE — no absolute scale)
          - Calinski-Harabasz (higher = better; RELATIVE — no absolute scale)

        K is decided by SILHOUETTE, because it is the only criterion that can
        say whether a partition is meaningful at all. Davies-Bouldin and
        Calinski-Harabasz are relative indices: on near-continuous data they
        always nominate some K, and an earlier multi-criterion vote let them
        override silhouette into a worse-separated partition (e.g. selecting
        K=6 at silhouette 0.19 when the silhouette peak was K=3 at 0.28).
        They are now used only to break ties between K values whose
        silhouette is within `sil_tol` of the peak, and are reported in
        `all_scores` for transparency. When the silhouette peak itself is
        <= 0.25 every row is flagged `low_structure=True` so downstream text
        can state honestly that the data has no rich cluster structure.
        """
        from sklearn.metrics import davies_bouldin_score, calinski_harabasz_score
        n = len(X)
        upper = min(max_k, n - 1, 15)
        all_scores: list[dict] = []
        per_k_labels: dict[int, np.ndarray] = {}
        per_k_sil: dict[int, float] = {}
        per_k_db: dict[int, float] = {}
        per_k_ch: dict[int, float] = {}

        for k in range(2, upper + 1):
            km = KMeans(n_clusters=k, n_init=10, random_state=42)
            lbl = km.fit_predict(X)
            sil = float(silhouette_score(X, lbl))
            try:
                db = float(davies_bouldin_score(X, lbl))
                ch = float(calinski_harabasz_score(X, lbl))
            except Exception:
                db = float("inf")
                ch = 0.0
            all_scores.append({
                "k": k,
                "silhouette": round(sil, 4),
                "davies_bouldin": round(db, 4),
                "calinski_harabasz": round(ch, 2),
            })
            per_k_labels[k] = lbl
            per_k_sil[k] = sil
            per_k_db[k] = db
            per_k_ch[k] = ch

        if not per_k_sil:
            return 2, -1.0, np.zeros(n, dtype=int), all_scores

        # ── v6.2 silhouette-gated selection ──
        # Silhouette decides K. Davies-Bouldin / Calinski-Harabasz only break
        # ties between K values whose silhouette is statistically
        # indistinguishable from the peak (within sil_tol).
        sil_tol = 0.02
        peak_sil = max(per_k_sil.values())
        contenders = [k for k, s in per_k_sil.items() if peak_sil - s <= sil_tol]
        if len(contenders) == 1:
            best_k = contenders[0]
        else:
            # tie-break among silhouette-equivalent K: lowest Davies-Bouldin
            best_k = min(contenders, key=lambda k: per_k_db[k])
        # peak silhouette <= 0.25 -> no rich cluster structure; any K is then
        # a descriptive segmentation of a continuum, not a set of natural kinds.
        low_structure = peak_sil <= 0.25

        vote_sil = max(per_k_sil, key=per_k_sil.get)
        vote_db = min(per_k_db, key=per_k_db.get)
        vote_ch = max(per_k_ch, key=per_k_ch.get)
        for row in all_scores:
            row["vote_silhouette"] = (row["k"] == vote_sil)
            row["vote_davies_bouldin"] = (row["k"] == vote_db)
            row["vote_calinski_harabasz"] = (row["k"] == vote_ch)
            row["is_selected"] = (row["k"] == best_k)
            row["low_structure"] = low_structure

        return best_k, per_k_sil[best_k], per_k_labels[best_k], all_scores

    @staticmethod
    def _fit_gmm_bic(
        X: np.ndarray,
        k_range: tuple[int, int] = (2, 8),
    ) -> tuple[int, float, np.ndarray | None, list[dict]]:
        """Gaussian Mixture clustering with silhouette-gated, BIC-arbitrated K.

        Returns
        -------
        best_k          : int       — K selected by the silhouette gate (BIC breaks ties)
        best_silhouette : float     — silhouette at the chosen K (for UI badge)
        best_labels     : np.ndarray| None — cluster assignments, None on failure
        diagnostic      : list[dict] — per-K metrics for the silhouette-curve chart:
            [{"k": int, "bic": float, "silhouette": float, "log_likelihood": float,
              "is_selected": bool}, ...]

        BIC (Schwarz 1978) is the standard model-selection criterion for
        finite mixture models, but on a continuous streetscape gradient it
        keeps adding mixture components whenever the likelihood gain beats
        its complexity penalty — carving a structureless cloud into
        separation-free slivers. v6.2 therefore gates K on the silhouette
        coefficient (the only absolute-scale validity index): among the K
        values whose silhouette sits within ``sil_tol`` of the peak, BIC
        arbitrates (lower = better). This keeps the GMM-BIC path as honest
        about weak structure as the KMeans fallback's ``_find_optimal_k``.
        """
        n = len(X)
        lo, hi = k_range
        hi = min(hi, n - 1)
        if hi < lo:
            return 0, -1.0, None, []

        diagnostic: list[dict] = []
        per_k_labels: dict[int, np.ndarray] = {}
        per_k_bic: dict[int, float] = {}
        per_k_sil: dict[int, float] = {}
        per_k_ll: dict[int, float] = {}

        for k in range(lo, hi + 1):
            try:
                gmm = GaussianMixture(
                    n_components=k,
                    covariance_type="full",
                    n_init=5,
                    random_state=42,
                    reg_covar=1e-4,  # avoids singular covariance when features near-collinear
                )
                gmm.fit(X)
                bic = float(gmm.bic(X))
                ll = float(gmm.score(X) * n)  # total log-likelihood
                lbl = gmm.predict(X)
                if len(set(lbl)) < 2:
                    continue
                sil = float(silhouette_score(X, lbl))
                per_k_labels[k] = lbl
                per_k_bic[k] = bic
                per_k_sil[k] = sil
                per_k_ll[k] = ll
            except Exception as e:
                logger.warning("GMM(k=%d) failed: %s", k, e)

        if not per_k_bic:
            return 0, -1.0, None, []

        # ── v6.2 silhouette-gated selection (mirrors _find_optimal_k) ──
        # Pure minimum-BIC keeps adding mixture components on a continuous
        # gradient. Silhouette is the only index on an absolute scale, so it
        # gates K: among the K values whose silhouette is within sil_tol of
        # the peak, BIC arbitrates (lower = better). If even the peak
        # silhouette is <= 0.25 the data carries no real cluster structure
        # and the smallest such K is the honest choice.
        sil_tol = 0.02
        peak_sil = max(per_k_sil.values())
        contenders = [k for k, s in per_k_sil.items()
                      if peak_sil - s <= sil_tol]
        if len(contenders) == 1:
            best_k = contenders[0]
        else:
            best_k = min(contenders, key=lambda k: per_k_bic[k])
        low_structure = peak_sil <= 0.25
        if low_structure:
            logger.info(
                "GMM-BIC: peak silhouette %.3f <= 0.25 — weak cluster "
                "structure; selecting smallest silhouette-tied k=%d",
                peak_sil, best_k,
            )
        best_sil = per_k_sil[best_k]
        best_labels = per_k_labels[best_k]

        # Build diagnostic table for the UI silhouette-curve chart (extended
        # with BIC + log-likelihood so the user sees the full evidence).
        for k in sorted(per_k_bic.keys()):
            diagnostic.append({
                "k": k,
                "bic": round(per_k_bic[k], 2),
                "silhouette": round(per_k_sil[k], 4),
                "log_likelihood": round(per_k_ll[k], 2),
                "is_selected": (k == best_k),
            })

        return best_k, best_sil, best_labels, diagnostic

    # ------------------------------------------------------------------
    # v6.2 — cluster-validity diagnostics (tendency · gap · stability)
    # ------------------------------------------------------------------

    @staticmethod
    def _hopkins_statistic(
        X: np.ndarray,
        sample_ratio: float = 0.1,
        random_state: int = 42,
    ) -> float:
        """Hopkins statistic of clustering tendency.

        Sampled on the standardised feature matrix. H ~ 0.5 means the data
        is indistinguishable from a uniform random cloud (no meaningful
        clusters); H -> 1.0 indicates strong cluster structure. Reporting
        this BEFORE choosing K stops the pipeline from imposing archetypes
        on data that has none — a continuous streetscape gradient honestly
        scores in the 0.5-0.7 range.
        """
        rng = np.random.default_rng(random_state)
        n, d = X.shape
        m = min(max(5, int(n * sample_ratio)), n - 1)
        if m < 1:
            return 0.5
        nn = NearestNeighbors(n_neighbors=2).fit(X)
        # w_i: distance from a sampled REAL point to its nearest other real point
        real_idx = rng.choice(n, size=m, replace=False)
        w_dist, _ = nn.kneighbors(X[real_idx], n_neighbors=2)
        w = w_dist[:, 1]
        # u_i: distance from a uniform-random point to its nearest real point
        lo, hi = X.min(axis=0), X.max(axis=0)
        U = rng.uniform(lo, hi, size=(m, d))
        u_dist, _ = nn.kneighbors(U, n_neighbors=1)
        u = u_dist[:, 0]
        denom = float(np.sum(u) + np.sum(w))
        return 0.5 if denom == 0 else float(np.sum(u) / denom)

    @staticmethod
    def _gap_statistic(
        X: np.ndarray,
        k_range: tuple[int, int] = (2, 8),
        n_refs: int = 10,
        random_state: int = 42,
    ) -> list[dict]:
        """Tibshirani et al. (2001) gap statistic.

        Compares the within-cluster dispersion of the data against that of
        ``n_refs`` uniform reference datasets drawn over the data's bounding
        box. Returns ``[{k, gap, s_k, is_selected}, ...]``; the selected K
        is the smallest k with Gap(k) >= Gap(k+1) - s_{k+1}. Reported as an
        independent K-validity criterion — it does NOT override the
        primary K selection.
        """
        rng = np.random.default_rng(random_state)
        lo, hi = k_range
        hi = min(hi, len(X) - 1)
        if hi < lo:
            return []
        # PCA-aligned reference box (Tibshirani et al. 2001, method b):
        # uniform over the bounding box of the data's principal components,
        # back-transformed to feature space. A raw axis-aligned bounding box
        # inflates the gap for spread-out data and never lets the curve peak.
        mu = X.mean(axis=0)
        Xc = X - mu
        try:
            _, _, Vt = np.linalg.svd(Xc, full_matrices=False)
        except np.linalg.LinAlgError:
            Vt = np.eye(X.shape[1])
        Xpc = Xc @ Vt.T
        pc_lo, pc_hi = Xpc.min(axis=0), Xpc.max(axis=0)

        def _make_reference() -> np.ndarray:
            return rng.uniform(pc_lo, pc_hi, size=X.shape) @ Vt + mu

        def _log_dispersion(data: np.ndarray, k: int) -> float:
            km = KMeans(n_clusters=k, n_init=10, random_state=random_state)
            lab = km.fit_predict(data)
            w = 0.0
            for c in range(k):
                pts = data[lab == c]
                if len(pts) > 1:
                    w += float(((pts - pts.mean(axis=0)) ** 2).sum())
            return float(np.log(w)) if w > 0 else 0.0

        gaps: dict[int, float] = {}
        sks: dict[int, float] = {}
        rows: list[dict] = []
        for k in range(lo, hi + 1):
            obs = _log_dispersion(X, k)
            refs = np.array([
                _log_dispersion(_make_reference(), k)
                for _ in range(n_refs)
            ])
            gap = float(refs.mean() - obs)
            sk = float(refs.std() * np.sqrt(1.0 + 1.0 / n_refs))
            gaps[k] = gap
            sks[k] = sk
            rows.append({"k": k, "gap": round(gap, 4), "s_k": round(sk, 4)})
        best_k = lo
        for k in range(lo, hi):
            if gaps[k] >= gaps[k + 1] - sks[k + 1]:
                best_k = k
                break
        else:
            best_k = max(gaps, key=gaps.get) if gaps else lo
        for r in rows:
            r["is_selected"] = (r["k"] == best_k)
        return rows

    @staticmethod
    def _bootstrap_cluster_stability(
        X: np.ndarray,
        base_labels: np.ndarray,
        k: int,
        n_boot: int = 100,
        random_state: int = 42,
    ) -> dict[str, float]:
        """Hennig (2007) bootstrap cluster stability.

        For each of ``n_boot`` bootstrap resamples the data is re-clustered
        (KMeans, same k); for every original cluster the maximum Jaccard
        similarity to any bootstrap cluster is recorded, then averaged.
        Returns ``{cluster_id: mean Jaccard}`` in [0, 1]. Hennig's bands:
        >= 0.85 highly stable, 0.75-0.85 stable, 0.60-0.75 indicates a
        pattern, < 0.60 unstable / dissolved. This measures whether each
        archetype is a robust feature of the data or an artefact of one
        particular partition.
        """
        rng = np.random.default_rng(random_state)
        n = len(X)
        base = np.asarray(base_labels)
        clusters = sorted({int(c) for c in base})
        base_sets = {c: set(np.where(base == c)[0].tolist()) for c in clusters}
        jacc: dict[int, list[float]] = {c: [] for c in clusters}
        for _ in range(n_boot):
            idx = rng.choice(n, size=n, replace=True)
            uniq = np.unique(idx)
            if len(uniq) <= k:
                continue
            try:
                bl = KMeans(n_clusters=k, n_init=5,
                            random_state=random_state).fit_predict(X[uniq])
            except Exception:
                continue
            uniq_set = set(uniq.tolist())
            boot_sets = [set(uniq[bl == bc].tolist()) for bc in range(k)]
            for c in clusters:
                orig = base_sets[c] & uniq_set
                if not orig:
                    continue
                best = 0.0
                for bs in boot_sets:
                    union = len(orig | bs)
                    if union:
                        best = max(best, len(orig & bs) / union)
                jacc[c].append(best)
        return {
            str(c): round(float(np.mean(v)), 4) if v else 0.0
            for c, v in jacc.items()
        }

    @staticmethod
    def _knn_smooth(
        coords: np.ndarray,
        labels: np.ndarray,
        k: int,
    ) -> np.ndarray:
        """Relabel each point to the majority class among its k nearest
        neighbours. Operates ONLY over rows with valid (finite) coordinates;
        rows without GPS keep their original feature-space label. For a fully
        GPS-covered run this is identical to smoothing every row."""
        valid = np.isfinite(coords).all(axis=1)
        if int(valid.sum()) <= k:
            return labels  # too few GPS points to smooth meaningfully
        sub_coords = coords[valid]
        sub_labels = labels[valid]
        nn = NearestNeighbors(n_neighbors=min(k, len(sub_coords)), metric="euclidean")
        nn.fit(sub_coords)
        _, indices = nn.kneighbors(sub_coords)
        smoothed_sub = np.empty_like(sub_labels)
        for i, neighbours in enumerate(indices):
            neighbour_labels = sub_labels[neighbours]
            counts = np.bincount(neighbour_labels)
            smoothed_sub[i] = int(np.argmax(counts))
        out = labels.copy()
        out[valid] = smoothed_sub
        return out

    @staticmethod
    def _profile_archetypes(
        df: pd.DataFrame,
        X_scaled: np.ndarray,
        labels: np.ndarray,
        ind_ids: list[str],
        ind_defs: dict[str, IndicatorDefinitionInput],
    ) -> list[ArchetypeProfile]:
        """Compute centroid values and z-scores per cluster, generate label."""
        profiles = []
        for cid in sorted(set(labels)):
            mask = labels == cid
            centroid_raw = df.loc[mask].mean()
            centroid_z = pd.Series(X_scaled[mask].mean(axis=0), index=ind_ids)

            label = _name_archetype(centroid_z, ind_defs)

            profiles.append(ArchetypeProfile(
                archetype_id=int(cid),
                archetype_label=label,
                point_count=int(mask.sum()),
                centroid_values={k: round(float(v), 4) for k, v in centroid_raw.items()},
                centroid_z_scores={k: round(float(v), 4) for k, v in centroid_z.items()},
            ))
        return profiles

    @staticmethod
    def _build_segments(
        df: pd.DataFrame,
        labels: np.ndarray,
        point_ids: list[str],
        coords: np.ndarray | None,
        archetypes: list[ArchetypeProfile],
        ind_ids: list[str],
    ) -> list[SpatialSegment]:
        """Build one SpatialSegment per cluster."""
        arch_map = {a.archetype_id: a for a in archetypes}
        segments = []
        for cid in sorted(set(labels)):
            mask = labels == cid
            arch = arch_map.get(int(cid))
            pids = [point_ids[i] for i in range(len(labels)) if mask[i]]

            lat_range, lng_range = [], []
            if coords is not None:
                c = coords[mask]
                lat_range = [round(float(c[:, 0].min()), 6), round(float(c[:, 0].max()), 6)]
                lng_range = [round(float(c[:, 1].min()), 6), round(float(c[:, 1].max()), 6)]

            segments.append(SpatialSegment(
                segment_id=f"seg_{cid}",
                archetype_id=int(cid),
                archetype_label=arch.archetype_label if arch else "",
                point_count=int(mask.sum()),
                point_ids=pids,
                lat_range=lat_range,
                lng_range=lng_range,
                centroid_indicators=arch.centroid_values if arch else {},
                centroid_z_scores=arch.centroid_z_scores if arch else {},
            ))
        return segments

    @staticmethod
    def _build_segment_diagnostics(
        df: pd.DataFrame,
        X_scaled: np.ndarray,
        labels: np.ndarray,
        ind_ids: list[str],
        ind_defs: dict[str, IndicatorDefinitionInput],
        archetypes: list[ArchetypeProfile],
        coords: np.ndarray | None,
        point_ids: list[str],
    ) -> list[ZoneDiagnostic]:
        """Generate descriptive zone_diagnostics-compatible records for each cluster (v6.0)."""
        arch_map = {a.archetype_id: a for a in archetypes}
        diagnostics: list[ZoneDiagnostic] = []

        for cid in sorted(set(labels)):
            mask = labels == cid
            arch = arch_map.get(int(cid))
            centroid_z = pd.Series(X_scaled[mask].mean(axis=0), index=ind_ids)
            centroid_raw = df.loc[mask].mean()

            # Build descriptive indicator_status (value + z_score + target_direction only)
            indicator_status: dict[str, dict] = {}
            for ind_id in ind_ids:
                z = float(centroid_z[ind_id])
                val = float(centroid_raw[ind_id]) if ind_id in centroid_raw else None
                defn = ind_defs.get(ind_id)
                indicator_status[ind_id] = {
                    "full": {
                        "value": round(val, 4) if val is not None else None,
                        "z_score": round(z, 3),
                        "target_direction": defn.target_direction if defn else "INCREASE",
                    }
                }

            mean_abs_z = round(float(centroid_z.abs().mean()), 4)

            diagnostics.append(ZoneDiagnostic(
                zone_id=f"seg_{cid}",
                zone_name=arch.archetype_label if arch else f"Segment {cid}",
                area_sqm=0,
                mean_abs_z=mean_abs_z,
                point_count=int(mask.sum()),
                indicator_status=indicator_status,
            ))

        diagnostics.sort(key=lambda d: d.mean_abs_z, reverse=True)
        for rank, d in enumerate(diagnostics, 1):
            d.rank = rank
        return diagnostics


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------

def _name_archetype(
    centroid_z: pd.Series,
    ind_defs: dict[str, IndicatorDefinitionInput],
) -> str:
    """Generate a human-readable label from top 3 z-score features."""
    sorted_z = centroid_z.abs().sort_values(ascending=False)
    parts = []
    for ind_id in sorted_z.index[:3]:
        z = centroid_z[ind_id]
        short_name = ind_defs[ind_id].name if ind_id in ind_defs else ind_id
        # Abbreviate to first meaningful word
        short = short_name.split()[0] if short_name else ind_id
        prefix = "High" if z > 0 else "Low"
        parts.append(f"{prefix}-{short}")
    return " / ".join(parts)
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    
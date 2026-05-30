"""
Metrics Calculation Service
Executes indicator calculations using calculator modules
"""

import os
import io
import sys
import json
import logging
import importlib.util
from pathlib import Path
from typing import Optional, Any

import numpy as np

from app.models.metrics import CalculationResult, BatchCalculationResponse

logger = logging.getLogger(__name__)


class MetricsCalculator:
    """Metrics Calculator - executes indicator calculations"""

    def __init__(self, metrics_code_dir: str):
        self.metrics_code_dir = Path(metrics_code_dir)
        self.loaded_modules: dict[str, Any] = {}
        self.semantic_colors: dict[str, tuple[int, int, int]] = {}

        # Ensure directory exists
        self.metrics_code_dir.mkdir(parents=True, exist_ok=True)

    def load_semantic_colors(self, config_path: str) -> bool:
        """Load semantic color configuration from JSON"""
        try:
            path = Path(config_path)
            if not path.exists():
                logger.error(f"Semantic config not found: {config_path}")
                return False

            with open(path, 'r', encoding='utf-8') as f:
                config = json.load(f)

            self.semantic_colors = {}
            for item in config:
                name = item.get('name', '')
                hex_color = item.get('color', '')
                if name and hex_color:
                    h = hex_color.lstrip('#')
                    rgb = tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
                    self.semantic_colors[name] = rgb

            logger.info(f"Loaded {len(self.semantic_colors)} semantic classes")
            return True

        except Exception as e:
            logger.error(f"Failed to load semantic colors: {e}")
            return False

    def load_calculator_module(self, indicator_id: str) -> Optional[Any]:
        """Load a calculator module by indicator ID"""
        try:
            cache_key = f"calc_{indicator_id}"
            if cache_key in self.loaded_modules:
                return self.loaded_modules[cache_key]

            calc_path = self.metrics_code_dir / f"calculator_layer_{indicator_id}.py"
            if not calc_path.exists():
                logger.error(f"Calculator not found: {calc_path}")
                return None

            # Load module
            spec = importlib.util.spec_from_file_location(
                f"calculator_{indicator_id}",
                calc_path
            )
            module = importlib.util.module_from_spec(spec)

            # Inject semantic_colors before execution
            module.semantic_colors = self.semantic_colors

            # Some calculators (e.g. IND_GVI_ANG, IND_NAT_LND, IND_DIR_RAT, …)
            # were originally written for the standalone `shared_layer/` pipeline
            # and start with a real `from input_layer import semantic_colors`.
            # In the FastAPI service that module isn't on sys.path, so without
            # intervention the import raises ModuleNotFoundError, the whole
            # calculator fails to load, and every calculate() call for that
            # indicator counts as a failure (visible as the "N failed" badge
            # in the pipeline UI).
            #
            # Fix: register a stub `input_layer` module in sys.modules so the
            # `from input_layer import semantic_colors` line resolves to the
            # same dict we just injected as a module attribute. The stub is
            # registered idempotently and shared across all calculator loads.
            if "input_layer" not in sys.modules:
                stub = importlib.util.module_from_spec(
                    importlib.util.spec_from_loader("input_layer", loader=None)
                )
                stub.semantic_colors = self.semantic_colors
                sys.modules["input_layer"] = stub
            else:
                # Keep the stub's semantic_colors fresh in case the dict was
                # reloaded between calls.
                sys.modules["input_layer"].semantic_colors = self.semantic_colors

            # Execute module — redirect stdout to avoid Windows GBK encoding
            # crashes from emoji characters in calculator print() statements
            old_stdout = sys.stdout
            sys.stdout = io.StringIO()
            try:
                spec.loader.exec_module(module)
            finally:
                sys.stdout = old_stdout

            # Validate required components
            if not hasattr(module, 'INDICATOR'):
                logger.error(f"Calculator missing INDICATOR dict: {indicator_id}")
                return None

            if not hasattr(module, 'calculate_indicator'):
                logger.error(f"Calculator missing calculate_indicator function: {indicator_id}")
                return None

            # Cache and return
            self.loaded_modules[cache_key] = module
            return module

        except Exception as e:
            logger.error(f"Failed to load calculator module {indicator_id}: {e}")
            return None

    def calculate(self, indicator_id: str, image_path: str) -> CalculationResult:
        """Calculate indicator for a single image"""
        try:
            module = self.load_calculator_module(indicator_id)
            if not module:
                return CalculationResult(
                    success=False,
                    indicator_id=indicator_id,
                    error=f"Failed to load calculator: {indicator_id}"
                )

            # Call calculate_indicator function
            result = module.calculate_indicator(image_path)

            return CalculationResult(
                success=result.get('success', False),
                indicator_id=indicator_id,
                indicator_name=module.INDICATOR.get('name', ''),
                value=result.get('value'),
                unit=module.INDICATOR.get('unit', ''),
                target_pixels=result.get('target_pixels'),
                total_pixels=result.get('total_pixels'),
                class_breakdown=result.get('class_breakdown', {}),
                error=result.get('error'),
                image_path=image_path,
            )

        except Exception as e:
            logger.error(f"Calculator error {indicator_id}: {e}")
            return CalculationResult(
                success=False,
                indicator_id=indicator_id,
                error=str(e),
                image_path=image_path,
            )

    def calculate_for_layer(
        self,
        indicator_id: str,
        semantic_map_path: str,
        mask_path: str,
        original_photo_path: Optional[str] = None,
        depth_map_path: Optional[str] = None,
    ) -> CalculationResult:
        """
        Calculate indicator within a masked spatial layer.

        v8.0 — `original_photo_path` is the path to the unmodified RGB
        photograph the user uploaded; `semantic_map_path` is the
        ADE20K-style class colour map. Calculators that need photographic
        features (Hasler-Süsstrunk colorfulness, HSV saturation, GLCM
        texture, Canny edges, mean luminance) must read the PHOTO, not the
        semantic map — otherwise the formula degenerates to a function of
        the class palette and outputs cluster tightly. The orchestrator
        now passes both paths; per-calculator dispatch picks whichever it
        actually needs.

        Dispatch priority:
          1. If the calculator module exposes a custom `calculate_for_layer`
             function, call it. We try the new 3-arg form
             `(semantic_map_path, mask_path, original_photo_path)` first;
             if the calculator only accepts 2 args, we fall back to
             `(semantic_map_path, mask_path)`.
          2. Otherwise, run the default TYPE A pipeline: load TARGET_RGB,
             count matching pixels inside the mask, return
             (target / mask_pixels) * 100.
          3. Last-resort fallback: call the module's whole-image
             `calculate_indicator(semantic_map_path)` (layer info lost).
        """
        try:
            module = self.load_calculator_module(indicator_id)
            if not module:
                return CalculationResult(
                    success=False,
                    indicator_id=indicator_id,
                    error=f"Failed to load calculator: {indicator_id}",
                )

            # --- (1) Per-calculator custom layer function (TYPE B contract) ---
            custom_fn = getattr(module, "calculate_for_layer", None)
            if callable(custom_fn):
                # Try richer signatures first then degrade. Supported:
                #   (sem, mask, photo, depth)  — full v8.0
                #   (sem, mask, photo)         — v8.0 photo-aware
                #   (sem, mask)                — legacy
                #   calculate_indicator(sem)   — whole-image fallback
                result = None
                if depth_map_path is not None:
                    try:
                        result = custom_fn(
                            semantic_map_path, mask_path,
                            original_photo_path, depth_map_path,
                        )
                    except TypeError:
                        result = None
                if result is None and original_photo_path is not None:
                    try:
                        result = custom_fn(
                            semantic_map_path, mask_path, original_photo_path,
                        )
                    except TypeError:
                        result = None
                if result is None:
                    try:
                        result = custom_fn(semantic_map_path, mask_path)
                    except TypeError:
                        # Some calculators only take semantic_map_path; fall back
                        result = module.calculate_indicator(semantic_map_path)
                if isinstance(result, dict):
                    return CalculationResult(
                        success=result.get("success", False),
                        indicator_id=indicator_id,
                        indicator_name=module.INDICATOR.get("name", ""),
                        value=result.get("value"),
                        unit=module.INDICATOR.get("unit", ""),
                        target_pixels=result.get("target_pixels"),
                        total_pixels=result.get("total_pixels"),
                        error=result.get("error"),
                        image_path=semantic_map_path,
                    )
                # If custom_fn returned a CalculationResult-like object, pass through
                return result

            # v8.0 — full-image calls reach this branch with mask_path=None
            # (analysis.py routes both layered and whole-image runs through
            # calculate_for_layer so photo_path propagation stays in one
            # place). The default TYPE A pipeline below needs a real mask,
            # so without one we hand off to the calculator's whole-image
            # entry point.
            if not mask_path:
                result = module.calculate_indicator(semantic_map_path)
                return CalculationResult(
                    success=result.get("success", False),
                    indicator_id=indicator_id,
                    indicator_name=module.INDICATOR.get("name", ""),
                    value=result.get("value"),
                    unit=module.INDICATOR.get("unit", ""),
                    target_pixels=result.get("target_pixels"),
                    total_pixels=result.get("total_pixels"),
                    error=result.get("error"),
                    image_path=semantic_map_path,
                )

            from PIL import Image

            # Load semantic map as RGB numpy array
            with Image.open(semantic_map_path) as sem_img:
                sem_img = sem_img.convert("RGB")
                sem_arr = np.array(sem_img)

            # Load layer mask as grayscale
            with Image.open(mask_path) as mask_img:
                mask_img = mask_img.convert("L")
                mask_arr = np.array(mask_img) > 127  # boolean mask

                if mask_arr.shape[:2] != sem_arr.shape[:2]:
                    # Resize mask to match semantic map
                    mask_img = mask_img.resize((sem_arr.shape[1], sem_arr.shape[0]), Image.NEAREST)
                    mask_arr = np.array(mask_img) > 127

            mask_pixels = int(np.sum(mask_arr))
            if mask_pixels == 0:
                return CalculationResult(
                    success=True,
                    indicator_id=indicator_id,
                    indicator_name=module.INDICATOR.get("name", ""),
                    value=0.0,
                    unit=module.INDICATOR.get("unit", ""),
                    target_pixels=0,
                    total_pixels=0,
                    image_path=semantic_map_path,
                )

            # Get TARGET_RGB from module (set by each calculator)
            target_rgb = getattr(module, "TARGET_RGB", None)
            if target_rgb is None:
                # Fallback: run full calculate_indicator on semantic map
                # (won't be layer-restricted but better than nothing)
                result = module.calculate_indicator(semantic_map_path)
                return CalculationResult(
                    success=result.get("success", False),
                    indicator_id=indicator_id,
                    indicator_name=module.INDICATOR.get("name", ""),
                    value=result.get("value"),
                    unit=module.INDICATOR.get("unit", ""),
                    target_pixels=result.get("target_pixels"),
                    total_pixels=result.get("total_pixels"),
                    error=result.get("error"),
                    image_path=semantic_map_path,
                )

            # Count target pixels within the masked region
            # TARGET_RGB can be:
            #   - dict {(r,g,b): class_name, ...} (from calculator modules)
            #   - list/tuple of RGB tuples
            #   - single RGB tuple (r,g,b)
            if isinstance(target_rgb, dict):
                # Dict keyed by RGB tuples — extract keys
                target_colors = [tuple(int(c) for c in rgb) for rgb in target_rgb.keys()]
            elif isinstance(target_rgb, (list, tuple)) and len(target_rgb) == 3 and isinstance(target_rgb[0], (int, float)):
                # Single target color
                target_colors = [tuple(int(c) for c in target_rgb)]
            elif isinstance(target_rgb, (list, tuple)):
                # Multiple target colors
                target_colors = [tuple(int(c) for c in rgb) for rgb in target_rgb]
            else:
                target_colors = []

            target_mask = np.zeros(sem_arr.shape[:2], dtype=bool)
            for rgb in target_colors:
                match = (
                    (sem_arr[:, :, 0] == rgb[0])
                    & (sem_arr[:, :, 1] == rgb[1])
                    & (sem_arr[:, :, 2] == rgb[2])
                )
                target_mask |= match

            # Combine: target pixels that are within the layer mask
            combined = target_mask & mask_arr
            target_pixels = int(np.sum(combined))
            value = (target_pixels / mask_pixels) * 100.0

            return CalculationResult(
                success=True,
                indicator_id=indicator_id,
                indicator_name=module.INDICATOR.get("name", ""),
                value=value,
                unit=module.INDICATOR.get("unit", ""),
                target_pixels=target_pixels,
                total_pixels=mask_pixels,
                image_path=semantic_map_path,
            )

        except Exception as e:
            logger.error("calculate_for_layer error %s: %s", indicator_id, e)
            return CalculationResult(
                success=False,
                indicator_id=indicator_id,
                error=str(e),
                image_path=semantic_map_path,
            )

    def batch_calculate(
        self,
        indicator_id: str,
        image_paths: list[str],
    ) -> BatchCalculationResponse:
        """Calculate indicator for multiple images"""
        results = []
        values = []

        for image_path in image_paths:
            result = self.calculate(indicator_id, image_path)
            results.append(result)
            if result.success and result.value is not None:
                values.append(result.value)

        # Get indicator info
        module = self.load_calculator_module(indicator_id)
        indicator_name = module.INDICATOR.get('name', '') if module else ''
        unit = module.INDICATOR.get('unit', '') if module else ''

        # Calculate statistics
        stats = {}
        if values:
            arr = np.array(values)
            stats = {
                'mean_value': float(np.mean(arr)),
                'std_value': float(np.std(arr)),
                'min_value': float(np.min(arr)),
                'max_value': float(np.max(arr)),
            }

        successful = sum(1 for r in results if r.success)

        return BatchCalculationResponse(
            success=successful > 0,
            indicator_id=indicator_id,
            indicator_name=indicator_name,
            unit=unit,
            total_images=len(image_paths),
            successful_calculations=successful,
            failed_calculations=len(image_paths) - successful,
            results=results,
            **stats,
        )

    def get_calculator_info(self, indicator_id: str) -> Optional[dict]:
        """Get INDICATOR dict from a calculator module"""
        module = self.load_calculator_module(indicator_id)
        if module and hasattr(module, 'INDICATOR'):
            return dict(module.INDICATOR)
        return None

    def clear_cache(self) -> None:
        """Clear loaded modules cache"""
        self.loaded_modules.clear()
        logger.info("Cleared calculator module cache")

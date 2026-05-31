"""
Vision Model API Client
Async HTTP client for communicating with the Vision API backend
"""

import base64
import json
import io
import time
import logging
from typing import Optional
from pathlib import Path

import httpx
from PIL import Image as PILImage

from app.models.vision import VisionAnalysisRequest, VisionAnalysisResponse

logger = logging.getLogger(__name__)


def _decode_depth_metric(b64: Optional[str]) -> Optional[bytes]:
    """Decode the Vision API's base64 `depth_metric_npy` field to raw .npy bytes.

    Returns the bytes ready to write to a `.npy` file (np.load can read them
    back). Returns None when the field is empty/missing or undecodable.
    """
    if not b64 or not isinstance(b64, str):
        return None
    try:
        return base64.b64decode(b64)
    except Exception as e:
        logger.warning("Failed to decode depth_metric_npy: %s", e)
        return None


class VisionModelClient:
    """Async Vision Model API client"""

    def __init__(
        self,
        base_url: str,
        timeout: float = 600.0,
        semantic_config_path: Optional[str] = None,
    ):
        self.base_url = base_url.rstrip('/')
        self.timeout = timeout
        self._health_info_cache: Optional[dict] = None
        self._health_cache_time: float = 0
        self._config_cache: Optional[dict] = None
        # Per-class RGB mapping loaded from Semantic_configuration.json.
        # The Vision API paints the semantic_map using whatever colors we
        # send, so we MUST send the same colors the downstream calculators
        # expect (which also load this config) — otherwise exact RGB
        # matching in the calculators fails and every indicator returns 0%
        # or weird values (see packages/backend/data/metrics_code/*.py).
        self._class_colors: dict[str, list[int]] = {}
        if semantic_config_path:
            self._load_class_colors(semantic_config_path)

    def _load_class_colors(self, config_path: str) -> None:
        """Load class-name → RGB mapping from Semantic_configuration.json."""
        try:
            path = Path(config_path)
            if not path.exists():
                logger.warning(
                    "Semantic config not found at %s — falling back to "
                    "generated colors (calculators will likely return 0%%)",
                    config_path,
                )
                return
            with open(path, encoding="utf-8") as f:
                config = json.load(f)
            for item in config:
                name = item.get("name", "")
                hex_color = item.get("color", "").lstrip("#")
                if name and len(hex_color) == 6:
                    self._class_colors[name] = [
                        int(hex_color[0:2], 16),
                        int(hex_color[2:4], 16),
                        int(hex_color[4:6], 16),
                    ]
            logger.info(
                "VisionModelClient loaded %d class colors from %s",
                len(self._class_colors), path.name,
            )
        except Exception as e:
            logger.error("Failed to load semantic config colors: %s", e)

    def _colors_for_selected_classes(self, semantic_classes: list[str]) -> dict[str, list[int]]:
        """Build index-keyed color dict for the Vision API based on the
        user-selected class list and the colors loaded from the JSON config.

        Falls back to generated colors if the config could not be loaded —
        in that case downstream calculators will not match, but at least
        the Vision API can still paint a mask."""
        if not self._class_colors:
            return self._generate_colors_for_classes(len(semantic_classes))
        out: dict[str, list[int]] = {}
        missing: list[str] = []
        for idx, class_name in enumerate(semantic_classes):
            rgb = self._class_colors.get(class_name)
            if rgb is None:
                missing.append(class_name)
                # Use an index-distinct fallback so different unknown classes
                # don't collide on the same colour.
                rgb = [(idx * 53) % 256, (idx * 97) % 256, (idx * 37) % 256]
            out[str(idx)] = rgb
        if missing:
            logger.warning(
                "No config colour for %d class(es) — using synthetic fallbacks: %s",
                len(missing), missing[:5],
            )
        return out

    def _get_default_colors(self) -> dict:
        """Get default color configuration"""
        semantic_colors = {
            "0": [0, 0, 0], "1": [6, 230, 230], "2": [4, 250, 7],
            "3": [250, 127, 4], "4": [4, 200, 3], "5": [204, 255, 4],
            "6": [9, 7, 230], "7": [120, 120, 70], "8": [180, 120, 120],
            "9": [255, 41, 10], "10": [150, 5, 61], "11": [120, 120, 120],
            "12": [140, 140, 140], "13": [235, 255, 7], "14": [255, 82, 0],
            "15": [0, 102, 200], "16": [204, 70, 3], "17": [255, 31, 0],
            "18": [255, 224, 0], "19": [255, 184, 6], "20": [255, 5, 153],
        }

        # Generate additional colors for up to 100 classes
        import random
        random.seed(42)
        color_set = set(tuple(c) for c in semantic_colors.values())

        for i in range(21, 201):
            while True:
                new_color = [random.randint(30, 255) for _ in range(3)]
                if tuple(new_color) not in color_set:
                    semantic_colors[str(i)] = new_color
                    color_set.add(tuple(new_color))
                    break

        return semantic_colors

    def _generate_colors_for_classes(self, num_classes: int) -> dict[str, list[int]]:
        """Generate color mapping for specified number of classes"""
        colors = self._get_default_colors()
        return {str(i): colors.get(str(i), [128, 128, 128]) for i in range(min(num_classes + 1, 201))}

    async def check_health(self) -> bool:
        """Check API health status with caching"""
        info = await self.get_health_info()
        return info is not None and info.get("status") == "healthy"

    async def get_health_info(self) -> Optional[dict]:
        """Fetch the full /health payload (cached for 5s).

        Returns the Vision API's health JSON which includes GPU info,
        currently loaded depth model, and the list of available models.
        Returns None if the Vision API is unreachable.
        """
        current_time = time.time()
        if (
            self._health_info_cache is not None
            and current_time - self._health_cache_time < 5
        ):
            return self._health_info_cache

        info: Optional[dict] = None
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(f"{self.base_url}/health", timeout=3.0)
                if response.status_code == 200:
                    info = response.json()
        except Exception as e:
            logger.warning(f"Health check failed: {e}")

        self._health_info_cache = info
        self._health_cache_time = current_time
        return info

    async def get_config(self) -> Optional[dict]:
        """Get API configuration with caching"""
        if self._config_cache is not None:
            return self._config_cache

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(f"{self.base_url}/config", timeout=5.0)
                if response.status_code == 200:
                    self._config_cache = response.json()
                    return self._config_cache
        except Exception as e:
            logger.error(f"Failed to get config: {e}")

        return None

    async def analyze_image(
        self,
        image_path: str,
        request: VisionAnalysisRequest,
    ) -> VisionAnalysisResponse:
        """
        Analyze image using Vision API

        Args:
            image_path: Path to the image file
            request: Analysis request parameters

        Returns:
            VisionAnalysisResponse with results
        """
        try:
            # Validate file exists
            path = Path(image_path)
            if not path.exists():
                return VisionAnalysisResponse(
                    status="error",
                    error=f"Image file not found: {image_path}"
                )

            # Build colors: prefer the real per-class colours from
            # Semantic_configuration.json so downstream calculators can match
            # pixels by RGB. See _load_class_colors() for rationale.
            semantic_colors = self._colors_for_selected_classes(request.semantic_classes)

            # Prepare request data — only fields the Vision API actually uses
            request_data = {
                "image_id": request.image_id or f"img_{int(time.time() * 1000)}",
                "semantic_classes": request.semantic_classes,
                "semantic_countability": request.semantic_countability,
                "openness_list": request.openness_list,
                "semantic_colors": semantic_colors,
                "enable_hole_filling": request.enable_hole_filling,
                "enable_median_blur": request.enable_median_blur,
            }

            start_time = time.time()

            # 大图自动降采样: 最长边超过 MAX_DIMENSION 时缩小再发送
            MAX_DIMENSION = 4096
            upload_bytes: Optional[bytes] = None
            upload_name = path.name

            try:
                with PILImage.open(image_path) as pil_img:
                    w_orig, h_orig = pil_img.size
                    if max(w_orig, h_orig) > MAX_DIMENSION:
                        scale = MAX_DIMENSION / max(w_orig, h_orig)
                        new_w, new_h = int(w_orig * scale), int(h_orig * scale)
                        pil_resized = pil_img.resize((new_w, new_h), PILImage.LANCZOS)
                        buf = io.BytesIO()
                        fmt = "JPEG" if path.suffix.lower() in (".jpg", ".jpeg") else "PNG"
                        pil_resized.save(buf, format=fmt, quality=92)
                        upload_bytes = buf.getvalue()
                        logger.info(
                            "Auto-resized %s: %dx%d (%.1fMP) → %dx%d (%.1fMP) before Vision API",
                            path.name, w_orig, h_orig, w_orig * h_orig / 1e6,
                            new_w, new_h, new_w * new_h / 1e6,
                        )
            except Exception as e:
                logger.warning("Failed to check/resize image %s: %s — sending original", path.name, e)

            async with httpx.AsyncClient(timeout=self.timeout) as client:
                if upload_bytes is not None:
                    files = {'file': (upload_name, upload_bytes, 'image/jpeg')}
                else:
                    _fh = open(image_path, 'rb')
                    files = {'file': (path.name, _fh, 'image/jpeg')}
                try:
                    data = {'request_data': json.dumps(request_data)}

                    response = await client.post(
                        f"{self.base_url}/analyze",
                        files=files,
                        data=data,
                    )
                finally:
                    if upload_bytes is None:
                        _fh.close()

            elapsed_time = time.time() - start_time
            logger.info("Vision API responded: status=%d elapsed=%.1fs image=%s", response.status_code, elapsed_time, path.name)

            if response.status_code == 200:
                result = response.json()

                if result.get('status') == 'success':
                    # Process image data (convert hex to bytes)
                    processed_images = {}
                    if 'images' in result:
                        for key, hex_data in result['images'].items():
                            if isinstance(hex_data, str):
                                processed_images[key] = bytes.fromhex(hex_data)

                    # Metric depth (.npy bytes) + metadata dict, when present
                    depth_metric_npy = _decode_depth_metric(result.get('depth_metric_npy'))
                    metadata = result.get('metadata') or {}

                    # 检查 Vision API 返回的语义分割状态
                    sem_status = result.get('semantic_status', 'unknown')
                    if sem_status == 'failed':
                        logger.warning(
                            "Vision API semantic segmentation FAILED for %s — "
                            "metrics will be 0 for this image", path.name,
                        )

                    return VisionAnalysisResponse(
                        status="success",
                        image_path=image_path,
                        processing_time=elapsed_time,
                        hole_filling_enabled=result.get('hole_filling_enabled', False),
                        image_count=len(processed_images),
                        statistics={
                            'detected_classes': result.get('detected_classes', 0),
                            'total_classes': result.get('total_classes', len(request.semantic_classes)),
                            'class_statistics': result.get('class_statistics', {}),
                            'fmb_statistics': result.get('fmb_statistics', {}),
                            'semantic_status': sem_status,
                        },
                        images=processed_images,
                        depth_metric_npy=depth_metric_npy,
                        metadata=metadata,
                        instances=result.get('instances', []),
                    )
                else:
                    return VisionAnalysisResponse(
                        status="error",
                        error=result.get('detail', 'API returned error status')
                    )
            else:
                error_msg = f"API error: {response.status_code}"
                try:
                    error_detail = response.json()
                    error_msg += f" - {error_detail.get('detail', response.text[:200])}"
                except Exception:
                    error_msg += f" - {response.text[:200]}"

                return VisionAnalysisResponse(status="error", error=error_msg)

        except Exception as e:
            logger.error(f"Vision API exception: {e}", exc_info=True)
            return VisionAnalysisResponse(status="error", error=str(e))

    async def analyze_panorama(
        self,
        image_path: str,
        request: VisionAnalysisRequest,
    ) -> dict[str, VisionAnalysisResponse]:
        """
        Analyze a panorama image using Vision API panorama endpoint.
        The API crops the panorama into 3 views (left/front/right), each producing masks.

        Returns:
            Dict mapping view name (left/front/right) to VisionAnalysisResponse
        """
        try:
            path = Path(image_path)
            if not path.exists():
                err = VisionAnalysisResponse(status="error", error=f"Image file not found: {image_path}")
                return {"left": err, "front": err, "right": err}

            # Use the REAL per-class colours from Semantic_configuration.json
            # (same as analyze_image), so the per-view semantic_map is rendered
            # with the exact RGB the downstream calculators match against. The
            # previous _generate_colors_for_classes() produced synthetic colours
            # by count, which did NOT match the calculators' TARGET_RGB and made
            # panorama indicators compute against the wrong palette.
            semantic_colors = self._colors_for_selected_classes(request.semantic_classes)

            request_data = {
                "image_id": request.image_id or f"img_{int(time.time() * 1000)}",
                "semantic_classes": request.semantic_classes,
                "semantic_countability": request.semantic_countability,
                "openness_list": request.openness_list,
                "semantic_colors": semantic_colors,
                "enable_hole_filling": request.enable_hole_filling,
                "enable_median_blur": request.enable_median_blur,
            }

            start_time = time.time()

            async with httpx.AsyncClient(timeout=self.timeout) as client:
                with open(image_path, 'rb') as f:
                    files = {'file': (path.name, f, 'image/jpeg')}
                    data = {'request_data': json.dumps(request_data)}

                    response = await client.post(
                        f"{self.base_url}/analyze/panorama",
                        files=files,
                        data=data,
                    )

            elapsed_time = time.time() - start_time
            logger.info("Vision panorama API responded: status=%d elapsed=%.1fs image=%s",
                        response.status_code, elapsed_time, path.name)

            if response.status_code == 200:
                result = response.json()

                if result.get('status') == 'success' and 'views' in result:
                    views: dict[str, VisionAnalysisResponse] = {}
                    for view_name, view_data in result['views'].items():
                        processed_images = {}
                        if 'images' in view_data:
                            for key, hex_data in view_data['images'].items():
                                if isinstance(hex_data, str):
                                    processed_images[key] = bytes.fromhex(hex_data)

                        views[view_name] = VisionAnalysisResponse(
                            status=view_data.get('status', 'error'),
                            image_path=image_path,
                            processing_time=elapsed_time / max(len(result['views']), 1),
                            hole_filling_enabled=view_data.get('hole_filling_enabled', False),
                            image_count=len(processed_images),
                            statistics={
                                'detected_classes': view_data.get('detected_classes', 0),
                                'total_classes': view_data.get('total_classes', len(request.semantic_classes)),
                                'class_statistics': view_data.get('class_statistics', {}),
                                'fmb_statistics': view_data.get('fmb_statistics', {}),
                            },
                            images=processed_images,
                            depth_metric_npy=_decode_depth_metric(view_data.get('depth_metric_npy')),
                            metadata=view_data.get('metadata') or {},
                            instances=view_data.get('instances', []),
                        )
                    return views
                else:
                    err = VisionAnalysisResponse(
                        status="error",
                        error=result.get('detail', 'Panorama API returned error status')
                    )
                    return {"left": err, "front": err, "right": err}
            else:
                error_msg = f"API error: {response.status_code}"
                try:
                    error_detail = response.json()
                    error_msg += f" - {error_detail.get('detail', response.text[:200])}"
                except Exception:
                    error_msg += f" - {response.text[:200]}"

                err = VisionAnalysisResponse(status="error", error=error_msg)
                return {"left": err, "front": err, "right": err}

        except Exception as e:
            logger.error(f"Vision panorama API exception: {e}", exc_info=True)
            err = VisionAnalysisResponse(status="error", error=str(e))
            return {"left": err, "front": err, "right": err}

    async def batch_analyze(
        self,
        image_paths: list[str],
        request: VisionAnalysisRequest,
    ) -> list[VisionAnalysisResponse]:
        """Analyze multiple images"""
        results = []
        for idx, image_path in enumerate(image_paths):
            logger.info(f"Batch analyzing image {idx + 1}/{len(image_paths)}")
            result = await self.analyze_image(image_path, request)
            results.append(result)
        return results

    def validate_parameters(
        self,
        semantic_classes: list[str],
        semantic_countability: list[int],
        openness_list: list[int],
    ) -> tuple[bool, str]:
        """Validate analysis parameters"""
        if not semantic_classes:
            return False, "Semantic classes list cannot be empty"

        if len(semantic_classes) > 200:
            return False, f"Class count ({len(semantic_classes)}) exceeds maximum (200)"

        if len(semantic_countability) != len(semantic_classes):
            return False, f"Countability length ({len(semantic_countability)}) doesn't match classes ({len(semantic_classes)})"

        if len(openness_list) != len(semantic_classes):
            return False, f"Openness length ({len(openness_list)}) doesn't match classes ({len(semantic_classes)})"

        if not all(x in [0, 1] for x in semantic_countability):
            return False, "Countability values must be 0 or 1"

        if not all(x in [0, 1] for x in openness_list):
            return False, "Openness values must be 0 or 1"

        return True, ""

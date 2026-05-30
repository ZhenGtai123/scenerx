"""Calculator Layer.

Indicator ID:   IND_SHA
Indicator Name: Shade Coverage
Type:           TYPE B (Custom Mathematical Formula

Description:
    The Shade Coverage (SHA) indicator calculates the proportion of a specific
    area or visual frame that is protected from direct solar radiation. Since
    semantic segmentation images do not contain actual shadow projection
    information, we calculate shade coverage based on sky visibility - areas
    where sky is NOT visible are considered shaded. SHA = 1 - VF_sky Where
    VF_sky is the weighted sky visibility factor using horizontal bands adapted
    from the original fisheye View Factor formula.

Formula: )
"""

import numpy as np
from PIL import Image
from typing import Dict, List, Tuple


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    # Basic Information
    "id": "IND_SHA",
    "name": "Shade Coverage",
    "unit": "ratio",
    "formula": "SHA = 1 - VF_sky = 1 - sum(w_i * sky_i/t_i) / sum(w_i)",
    "formula_description": "Shade coverage based on sky visibility (top-weighted)",
    "target_direction": "POSITIVE",  # More shade is generally better for thermal comfort
    "definition": "Calculates the proportion of area protected from direct solar radiation based on sky visibility",
    "category": "CAT_CFG",
    
    # TYPE B Configuration
    "calc_type": "custom",  # Custom mathematical formula
    
    # Variables
    "variables": {
        "SHA": "Shade Coverage ratio",
        "VF_sky": "Weighted sky visibility factor",
        "n": "Total number of horizontal bands",
        "i": "Index of the specific band (1=top, n=bottom)",
        "sky_i": "Number of sky pixels in band i",
        "t_i": "Total number of pixels in band i",
        "w_i": "Position weight: (n-i+1)/n (linear, top-weighted)"
    },
    
    # Additional metadata
    "output_range": {
        "min": 0.0,
        "max": 1.0,
        "description": "0 = no shade (full sky visible); 1 = complete shade (no sky visible)"
    },
    "algorithm": "Sky visibility-based calculation with horizontal band weighting",
    "note": "SHA = 1 - VF_sky; Higher values indicate more shade coverage"
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Formula: {INDICATOR['formula']}")
print(f" Algorithm: {INDICATOR['algorithm']}")


# =============================================================================
# SKY CLASS IDENTIFICATION
# =============================================================================
# Keywords to identify sky-related semantic classes
SKY_KEYWORDS = ["sky", "cloud", "clouds"]

# Default sky color (if no semantic config provided)
DEFAULT_SKY_COLOR = (70, 130, 180)  # Steel blue - common sky color in segmentation


# =============================================================================
# VIEW FACTOR CALCULATION
# =============================================================================
def calculate_sky_view_factor(sky_mask: np.ndarray, n_bands: int = 10) -> Dict:
    """
    Calculate weighted Sky View Factor using horizontal bands.
    
    Adapted formula for perspective images:
    VF_sky = sum(w_i * sky_i/t_i) / sum(w_i)
    
    Where:
    - w_i = sin(pi * (2i - 1) / (2n))
    - sky_i = sky pixels in band i
    - t_i = total pixels in band i
    
    Top bands have higher weight because sky is typically at the top.
    
    Args:
        sky_mask: Binary mask where 1 = sky pixel, 0 = non-sky
        n_bands: Number of horizontal bands to divide the image
        
    Returns:
        Dictionary with VF_sky and band details
    """
    h, w = sky_mask.shape
    band_height = h // n_bands
    
    total_weighted_sky = 0.0
    total_weight = 0.0
    band_results = []
    
    for i in range(1, n_bands + 1):
        # Calculate band boundaries
        y_start = (i - 1) * band_height
        y_end = i * band_height if i < n_bands else h
        
        # Extract band from sky mask
        band_mask = sky_mask[y_start:y_end, :]
        
        # Count sky pixels and total pixels in band
        sky_i = np.sum(band_mask > 0)  # Sky pixels
        t_i = band_mask.size            # Total pixels
        
        # Calculate band sky ratio
        band_ratio = sky_i / t_i if t_i > 0 else 0
        
        # Calculate weight: w_i = (n - i + 1) / n
        # Top bands (i=1) have highest weight, bottom bands (i=n) have lowest
        # This gives a linear decrease from top to bottom
        w_i = (n_bands - i + 1) / n_bands
        
        band_results.append({
            'band': i,
            'y_start': int(y_start),
            'y_end': int(y_end),
            'sky_pixels': int(sky_i),
            'total_pixels': int(t_i),
            'band_sky_ratio': round(band_ratio, 4),
            'weight': round(w_i, 4),
            'weighted_contribution': round(w_i * band_ratio, 4)
        })
        
        total_weighted_sky += w_i * band_ratio
        total_weight += w_i
    
    # Calculate VF_sky (normalized)
    if total_weight > 0:
        vf_sky = total_weighted_sky / total_weight
    else:
        vf_sky = 0.0
    
    # Also calculate simple (unweighted) sky ratio for comparison
    simple_sky_ratio = np.sum(sky_mask > 0) / sky_mask.size
    
    return {
        'vf_sky': vf_sky,
        'simple_sky_ratio': simple_sky_ratio,
        'n_bands': n_bands,
        'band_results': band_results,
        'total_weight': total_weight
    }


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(image_path: str, 
                        semantic_colors: Dict[str, Tuple[int, int, int]] = None,
                        n_bands: int = 10) -> Dict:
    """
    Calculate the Shade Coverage (SHA) indicator based on sky visibility.
    
    TYPE B - Custom Mathematical Formula
    
    Formula:
        SHA = 1 - VF_sky
        
        VF_sky = sum(w_i * sky_i/t_i) / sum(w_i)
        w_i = sin(pi * (2i - 1) / (2n))
        
    Logic: Areas where sky is NOT visible are considered shaded.
    
    Args:
        image_path: Path to the semantic segmentation mask image
        semantic_colors: Dictionary mapping class names to RGB tuples.
        n_bands: Number of horizontal bands for VF calculation (default: 10)
        
    Returns:
        dict: Result dictionary containing:
            - 'success' (bool): Whether calculation succeeded
            - 'value' (float): Shade coverage ratio (0 to 1)
            - 'vf_sky' (float): Sky view factor (weighted)
            - 'simple_sky_ratio' (float): Unweighted sky pixel ratio
            - 'sky_pixels' (int): Total sky pixels
            - 'total_pixels' (int): Total image pixels
            - 'error' (str): Error message if success is False
            
    Example:
        >>> result = calculate_indicator('/path/to/mask.png')
        >>> if result['success']:
        ...     print(f"Shade Coverage: {result['value']:.3f}")
        ...     print(f"Sky View Factor: {result['vf_sky']:.3f}")
    """
    try:
        # Step 1: Load and prepare the image
        img = Image.open(image_path).convert('RGB')
        pixels = np.array(img)
        h, w, _ = pixels.shape
        total_pixels = h * w

        # Step 2: Create sky mask
        sky_mask = np.zeros((h, w), dtype=np.uint8)
        sky_classes_found = {}

        # MetricsCalculator.calculate() invokes us as
        #   module.calculate_indicator(image_path)
        # without forwarding semantic_colors, which means the original code
        # silently fell through to the colour-heuristic branch below. That
        # heuristic uses
        #   (b > 150) & (b > r) & (b > g) & ((r+g+b) > 300)
        # which fails on the project's actual sky colour (cyan
        # #06E6E6 = RGB(6,230,230)) because `b > g` requires 230 > 230
        # = False. Every image's sky_mask ended up empty → VF_sky = 0 →
        # SHA = 1 - 0 = 1.00 for every zone, surfacing in the UI as
        # "IND_SHA has zero variance across zones (constant 1.00)".
        #
        # Fix: when no explicit argument is given, fall back to the
        # module-level `semantic_colors` dict that MetricsCalculator
        # injects at module load time (cf. metrics_calculator.py:80) —
        # this is the same dict IND_GVI and friends consume as a global.
        # The keyword-based class detection below then picks up "sky"
        # directly and uses its real RGB instead of the broken heuristic.
        if semantic_colors is None:
            try:
                semantic_colors = globals().get('semantic_colors')  # type: ignore[assignment]
            except Exception:
                semantic_colors = None

        if semantic_colors:
            # Use provided semantic color configuration
            for class_name, rgb in semantic_colors.items():
                # Check if this class is sky-related
                class_lower = class_name.lower()
                is_sky = any(sky_kw in class_lower for sky_kw in SKY_KEYWORDS)
                
                if is_sky:
                    mask = np.all(pixels == rgb, axis=2)
                    count = int(np.sum(mask))
                    if count > 0:
                        sky_mask[mask] = 1
                        sky_classes_found[class_name] = count
        else:
            # Try to detect sky by common colors (fallback)
            # Light blue colors often represent sky
            # This is a simple heuristic when no semantic config is provided
            r, g, b = pixels[:,:,0], pixels[:,:,1], pixels[:,:,2]
            # Sky typically: high blue, moderate-high overall brightness
            sky_like = (b > 150) & (b > r) & (b > g) & ((r + g + b) > 300)
            sky_mask[sky_like] = 1
            if np.sum(sky_like) > 0:
                sky_classes_found['detected_sky'] = int(np.sum(sky_like))
        
        # Step 3: Calculate Sky View Factor
        vf_result = calculate_sky_view_factor(sky_mask, n_bands)
        
        # Step 4: Calculate Shade Coverage
        # SHA = 1 - VF_sky
        shade_coverage = 1.0 - vf_result['vf_sky']
        simple_shade = 1.0 - vf_result['simple_sky_ratio']
        
        # Step 5: Calculate additional metrics
        sky_pixels = int(np.sum(sky_mask > 0))
        
        # Step 6: Return results
        return {
            'success': True,
            'value': round(shade_coverage, 3),
            'vf_sky': round(vf_result['vf_sky'], 3),
            'simple_sky_ratio': round(vf_result['simple_sky_ratio'], 3),
            'simple_shade': round(simple_shade, 3),
            'sky_pixels': sky_pixels,
            'non_sky_pixels': int(total_pixels - sky_pixels),
            'total_pixels': int(total_pixels),
            'sky_coverage_pct': round(vf_result['simple_sky_ratio'] * 100, 2),
            'shade_coverage_pct': round(simple_shade * 100, 2),
            'n_bands': n_bands,
            'sky_classes_found': sky_classes_found,
            'band_results': vf_result['band_results']
        }
        
    except FileNotFoundError:
        return {
            'success': False,
            'error': f'Image file not found: {image_path}',
            'value': None
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'value': None
        }


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================
def interpret_shade_coverage(shade: float) -> str:
    """
    Interpret the shade coverage value.
    
    Args:
        shade: Shade coverage ratio (0 to 1)
        
    Returns:
        str: Qualitative interpretation
    """
    if shade is None:
        return "Unable to interpret (no data)"
    elif shade < 0.1:
        return "Very low shade: mostly open sky"
    elif shade < 0.25:
        return "Low shade: limited overhead coverage"
    elif shade < 0.4:
        return "Moderate shade: partial sky blockage"
    elif shade < 0.6:
        return "Good shade: substantial sky blockage"
    elif shade < 0.8:
        return "High shade: extensive overhead coverage"
    else:
        return "Very high shade: minimal sky visible"


def explain_formula() -> str:
    """
    Provide educational explanation of the SHA formula.
    
    Returns:
        str: Explanation text
    """
    return """
    Shade Coverage (SHA) Formula - Based on Sky Visibility:
    
    SHA = 1 - VF_sky
    
    Where:
    VF_sky = sum(w_i * sky_i/t_i) / sum(w_i)
    w_i = (n - i + 1) / n  (linear, top-weighted)
    
    Components:
    - n = Number of horizontal bands (default: 10)
    - i = Band index (1 = top, n = bottom)
    - sky_i = Sky pixels in band i
    - t_i = Total pixels in band i
    - w_i = Weight for band i (top bands weighted higher)
    
    Logic:
    - Semantic segmentation shows what each pixel IS (sky, tree, building, etc.)
    - It does NOT show actual shadow projections
    - We use sky visibility as a proxy for shade:
      * Where you CAN see sky -> NOT shaded
      * Where you CANNOT see sky -> shaded (blocked by trees, buildings, etc.)
    
    Weighting (linear, top-weighted):
    - Top bands have higher weight because:
      * Sky is predominantly at the top of perspective images
      * Overhead shade (from canopy/buildings) is most effective
    
    Weight distribution (n=10):
      Band 1 (top):    w = 1.0   (highest)
      Band 2:          w = 0.9
      Band 3:          w = 0.8
      Band 4:          w = 0.7
      Band 5:          w = 0.6
      Band 6:          w = 0.5
      Band 7:          w = 0.4
      Band 8:          w = 0.3
      Band 9:          w = 0.2
      Band 10 (bottom): w = 0.1  (lowest)
    """


# =============================================================================
# STANDALONE TEST (Optional)
# =============================================================================
if __name__ == "__main__":
    import os
    
    print("\nTesting Shade Coverage calculator...")
    print(" Formula: SHA = 1 - VF_sky")
    
    # Test 1: Full sky (no shade)
    test_img_1 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_1[:, :] = [135, 206, 235]  # Sky blue
    
    test_path_1 = '/tmp/test_sha_1.png'
    Image.fromarray(test_img_1).save(test_path_1)
    
    # Create semantic config with sky
    test_semantic = {"sky": (135, 206, 235)}
    result_1 = calculate_indicator(test_path_1, test_semantic)
    
    print(f"\nTest 1: Full sky (100% sky)")
    print(f" Expected SHA: 0.000 (no shade)")
    print(f" Calculated SHA: {result_1.get('value', 'N/A')}")
    print(f" VF_sky: {result_1.get('vf_sky', 'N/A')}")
    
    os.remove(test_path_1)
    
    # Test 2: No sky (full shade)
    test_img_2 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_2[:, :] = [34, 139, 34]  # Forest green (tree)
    
    test_path_2 = '/tmp/test_sha_2.png'
    Image.fromarray(test_img_2).save(test_path_2)
    
    test_semantic_2 = {"tree": (34, 139, 34)}
    result_2 = calculate_indicator(test_path_2, test_semantic_2)
    
    print(f"\nTest 2: No sky (100% tree)")
    print(f" Expected SHA: 1.000 (full shade)")
    print(f" Calculated SHA: {result_2.get('value', 'N/A')}")
    print(f" VF_sky: {result_2.get('vf_sky', 'N/A')}")
    
    os.remove(test_path_2)
    
    # Test 3: Top half sky, bottom half tree
    test_img_3 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_3[:50, :] = [135, 206, 235]  # Sky in top half
    test_img_3[50:, :] = [34, 139, 34]    # Tree in bottom half
    
    test_path_3 = '/tmp/test_sha_3.png'
    Image.fromarray(test_img_3).save(test_path_3)
    
    test_semantic_3 = {"sky": (135, 206, 235), "tree": (34, 139, 34)}
    result_3 = calculate_indicator(test_path_3, test_semantic_3)
    
    print(f"\nTest 3: 50% sky at TOP, 50% tree at bottom")
    print(f" Expected: SHA < 0.5 (sky at top has higher weight)")
    print(f" Calculated SHA: {result_3.get('value', 'N/A')}")
    print(f" VF_sky: {result_3.get('vf_sky', 'N/A')}")
    print(f" Simple sky ratio: {result_3.get('simple_sky_ratio', 'N/A')}")
    
    os.remove(test_path_3)
    
    # Test 4: Top half tree, bottom half sky
    test_img_4 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_4[:50, :] = [34, 139, 34]    # Tree in top half
    test_img_4[50:, :] = [135, 206, 235]  # Sky in bottom half
    
    test_path_4 = '/tmp/test_sha_4.png'
    Image.fromarray(test_img_4).save(test_path_4)
    
    test_semantic_4 = {"sky": (135, 206, 235), "tree": (34, 139, 34)}
    result_4 = calculate_indicator(test_path_4, test_semantic_4)
    
    print(f"\nTest 4: 50% tree at TOP, 50% sky at bottom")
    print(f" Expected: SHA > 0.5 (tree at top blocks high-weight sky)")
    print(f" Calculated SHA: {result_4.get('value', 'N/A')}")
    print(f" VF_sky: {result_4.get('vf_sky', 'N/A')}")
    print(f" Simple sky ratio: {result_4.get('simple_sky_ratio', 'N/A')}")
    print(f" Interpretation: {interpret_shade_coverage(result_4.get('value'))}")
    
    os.remove(test_path_4)
    
    print("\n Test complete!")
    print("\n Note: SHA = 1 - VF_sky")
    print(" - When sky is visible -> low SHA (less shade)")
    print(" - When sky is blocked -> high SHA (more shade)")


# =============================================================================
# LAYER-AWARE CALCULATION (auto-added 2026-05-11)
# =============================================================================
def calculate_for_layer(semantic_map_path, mask_path=None):
    """Layer-aware wrapper. If mask_path provided, masks the semantic map
    to that layer before computing; else computes whole-image.
    
    The default strategy: copy semantic map, set non-mask pixels to 0
    (which won't match any real ADE20K color), then run calculate_indicator.
    """
    import numpy as np
    from PIL import Image
    import tempfile, os
    
    if not mask_path or not os.path.exists(mask_path):
        return calculate_indicator(semantic_map_path)
    
    try:
        sem_img = Image.open(semantic_map_path).convert('RGB')
        sem_arr = np.array(sem_img)
        with Image.open(mask_path) as m:
            m = m.convert('L')
            if m.size != (sem_arr.shape[1], sem_arr.shape[0]):
                m = m.resize((sem_arr.shape[1], sem_arr.shape[0]), Image.NEAREST)
            mask_arr = np.array(m) > 127
        # Apply mask: non-mask pixels set to black (0,0,0)
        sem_arr[~mask_arr] = 0
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            Image.fromarray(sem_arr).save(tmp.name)
            tmp_path = tmp.name
        try:
            result = calculate_indicator(tmp_path)
        finally:
            try: os.unlink(tmp_path)
            except: pass
        return result
    except Exception as e:
        return {'success': False, 'value': None, 'error': f'layer-aware wrapper failed: {e}'}

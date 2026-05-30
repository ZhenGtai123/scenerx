"""Calculator Layer.

Indicator ID:   IND_BEA_VIS
Indicator Name: Visual Beauty Score
Type:           TYPE E (Composite / Weighted Formula

Description:
    The Visual Beauty Score (BEA_VIS) is a perceptual score indicating how
    beautiful or aesthetically pleasing a street scene appears. It combines
    multiple sub-indices (Water Index, Color Tone, and Plant Richness) using
    empirically derived weights from perceptual studies.

Formula: )
"""

import numpy as np
from PIL import Image
from typing import Dict, List, Tuple
import colorsys


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    # Basic Information
    "id": "IND_BEA_VIS",
    "name": "Visual Beauty Score",
    "unit": "score",
    "formula": "SV = 1.04165 + 2.00634 × WI + 0.49522 × C + 0.23200 × PR",
    "formula_description": "Weighted combination of Water Index, Color Tone, and Plant Richness",
    "target_direction": "POSITIVE",  # Higher beauty score is better
    "definition": "A perceptual score indicating how beautiful or aesthetically pleasing a street scene appears",
    "category": "CAT_COM",
    
    # TYPE E Configuration
    "calc_type": "composite",  # Composite weighted formula
    
    # Formula coefficients
    "coefficients": {
        "intercept": 1.04165,
        "WI": 2.00634,   # Water Index weight
        "C": 0.49522,    # Color Tone weight
        "PR": 0.23200    # Plant Richness weight
    },
    
    # Variables
    "variables": {
        "SV": "Scenic View (Visual Beauty/Aesthetic judgment)",
        "WI": "Water Index (ratio of water pixels)",
        "C": "Overall color tone (colorfulness measure, 0-1)",
        "PR": "Plant richness (ratio of plant/vegetation pixels)"
    },
    
    # Additional metadata
    "output_range": {
        "min": "~1.04",
        "max": "unbounded (typically 1.0 to 4.0+)",
        "description": "Higher values indicate more visually pleasing scenes"
    },
    "algorithm": "Empirically weighted perceptual model",
    "note": "Based on perceptual studies correlating visual features with aesthetic preferences"
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Formula: {INDICATOR['formula']}")
print(f" Type: TYPE E (Composite / Weighted Formula)")


# =============================================================================
# CLASS IDENTIFICATION
# =============================================================================
# Keywords to identify water classes
WATER_KEYWORDS = [
    "water", "river", "lake", "pond", "pool",
    "sea", "ocean", "stream", "canal", "fountain"
]

# Keywords to identify plant/vegetation classes
PLANT_KEYWORDS = [
    "tree", "trees", "vegetation", "plant", "plants",
    "grass", "lawn", "foliage", "leaf", "leaves",
    "flower", "flowers", "bush", "shrub",
    "greenery", "flora", "garden"
]


def is_water_class(class_name: str) -> bool:
    """Check if a class name represents water."""
    class_lower = class_name.lower().replace("-", " ").replace("_", " ")
    return any(kw in class_lower for kw in WATER_KEYWORDS)


def is_plant_class(class_name: str) -> bool:
    """Check if a class name represents plants/vegetation."""
    class_lower = class_name.lower().replace("-", " ").replace("_", " ")
    return any(kw in class_lower for kw in PLANT_KEYWORDS)


# =============================================================================
# COLOR METRICS
# =============================================================================
def calculate_colorfulness(pixels: np.ndarray) -> float:
    """
    Calculate colorfulness metric from RGB image.
    
    Uses the Hasler and Süsstrunk colorfulness metric:
    C = sqrt(sigma_rg^2 + sigma_yb^2) + 0.3 * sqrt(mu_rg^2 + mu_yb^2)
    
    Normalized to 0-1 range for the formula.
    
    Args:
        pixels: numpy array of shape (H, W, 3) with RGB values
        
    Returns:
        float: Colorfulness score normalized to 0-1 range
    """
    # Convert to float
    pixels_float = pixels.astype(np.float64)
    
    # Split channels
    R = pixels_float[:, :, 0]
    G = pixels_float[:, :, 1]
    B = pixels_float[:, :, 2]
    
    # Calculate opponent color channels
    rg = R - G
    yb = 0.5 * (R + G) - B
    
    # Calculate statistics
    sigma_rg = np.std(rg)
    sigma_yb = np.std(yb)
    mu_rg = np.mean(rg)
    mu_yb = np.mean(yb)
    
    # Colorfulness metric
    colorfulness = np.sqrt(sigma_rg**2 + sigma_yb**2) + 0.3 * np.sqrt(mu_rg**2 + mu_yb**2)
    
    # Normalize to 0-1 range (typical colorfulness values are 0-100+)
    # Using 100 as a reasonable upper bound for normalization
    normalized = min(1.0, colorfulness / 100.0)
    
    return normalized


def calculate_saturation(pixels: np.ndarray) -> float:
    """
    Calculate mean saturation from RGB image.
    
    Alternative color tone metric using HSV saturation.
    
    Args:
        pixels: numpy array of shape (H, W, 3) with RGB values
        
    Returns:
        float: Mean saturation (0 to 1)
    """
    # Flatten to list of pixels
    flat_pixels = pixels.reshape(-1, 3)
    
    # Sample for efficiency (max 10000 pixels)
    if len(flat_pixels) > 10000:
        indices = np.random.choice(len(flat_pixels), 10000, replace=False)
        flat_pixels = flat_pixels[indices]
    
    # Convert RGB to HSV and extract saturation
    saturations = []
    for r, g, b in flat_pixels:
        h, s, v = colorsys.rgb_to_hsv(r/255.0, g/255.0, b/255.0)
        saturations.append(s)
    
    return np.mean(saturations)


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(image_path: str, 
                        semantic_colors: Dict[str, Tuple[int, int, int]] = None) -> Dict:
    """
    Calculate the Visual Beauty Score (BEA_VIS) indicator.
    
    TYPE E - Composite / Weighted Formula
    
    Formula:
        SV = 1.04165 + 2.00634 × WI + 0.49522 × C + 0.23200 × PR
        
    Where:
        WI = Water_Pixels / Total_Pixels (Water Index)
        C = Colorfulness metric (0 to 1)
        PR = Plant_Pixels / Total_Pixels (Plant Richness)
    
    Args:
        image_path: Path to the semantic segmentation mask image
        semantic_colors: Dictionary mapping class names to RGB tuples.
        
    Returns:
        dict: Result dictionary containing:
            - 'success' (bool): Whether calculation succeeded
            - 'value' (float): Visual Beauty Score
            - 'water_index' (float): WI component
            - 'color_tone' (float): C component
            - 'plant_richness' (float): PR component
            - 'contribution_WI' (float): WI contribution to score
            - 'contribution_C' (float): C contribution to score
            - 'contribution_PR' (float): PR contribution to score
            - 'error' (str): Error message if success is False
            
    Example:
        >>> result = calculate_indicator('/path/to/mask.png')
        >>> if result['success']:
        ...     print(f"Visual Beauty Score: {result['value']:.4f}")
    """
    try:
        # Step 1: Load and prepare the image
        img = Image.open(image_path).convert('RGB')
        pixels = np.array(img)
        h, w, _ = pixels.shape
        total_pixels = h * w
        
        # Step 2: Create masks for water and plants
        water_mask = np.zeros((h, w), dtype=np.uint8)
        plant_mask = np.zeros((h, w), dtype=np.uint8)
        
        water_classes_found = {}
        plant_classes_found = {}
        
        if semantic_colors:
            for class_name, rgb in semantic_colors.items():
                mask = np.all(pixels == rgb, axis=2)
                count = int(np.sum(mask))
                
                if count > 0:
                    if is_water_class(class_name):
                        water_mask[mask] = 1
                        water_classes_found[class_name] = count
                    elif is_plant_class(class_name):
                        plant_mask[mask] = 1
                        plant_classes_found[class_name] = count
        
        # Step 3: Calculate component indices
        water_pixels = int(np.sum(water_mask > 0))
        plant_pixels = int(np.sum(plant_mask > 0))
        
        # Water Index (WI)
        wi = water_pixels / total_pixels if total_pixels > 0 else 0.0
        
        # Plant Richness (PR)
        pr = plant_pixels / total_pixels if total_pixels > 0 else 0.0
        
        # Color Tone (C) - using colorfulness metric
        c = calculate_colorfulness(pixels)
        
        # Also calculate saturation as alternative
        saturation = calculate_saturation(pixels)
        
        # Step 4: Apply the formula
        # SV = 1.04165 + 2.00634 × WI + 0.49522 × C + 0.23200 × PR
        coef = INDICATOR['coefficients']
        
        intercept = coef['intercept']
        wi_contribution = coef['WI'] * wi
        c_contribution = coef['C'] * c
        pr_contribution = coef['PR'] * pr
        
        sv = intercept + wi_contribution + c_contribution + pr_contribution
        
        # Step 5: Calculate additional metrics
        water_pct = wi * 100
        plant_pct = pr * 100
        
        # Relative contributions
        total_contribution = wi_contribution + c_contribution + pr_contribution
        if total_contribution > 0:
            wi_rel = wi_contribution / total_contribution * 100
            c_rel = c_contribution / total_contribution * 100
            pr_rel = pr_contribution / total_contribution * 100
        else:
            wi_rel = c_rel = pr_rel = 0
        
        # Sort classes by pixel count
        sorted_water = dict(sorted(water_classes_found.items(), key=lambda x: x[1], reverse=True))
        sorted_plant = dict(sorted(plant_classes_found.items(), key=lambda x: x[1], reverse=True))
        
        # Step 6: Return results
        return {
            'success': True,
            'value': round(sv, 4),
            # Component values
            'water_index': round(wi, 4),
            'color_tone': round(c, 4),
            'plant_richness': round(pr, 4),
            'saturation': round(saturation, 4),
            # Contributions
            'contribution_intercept': round(intercept, 4),
            'contribution_WI': round(wi_contribution, 4),
            'contribution_C': round(c_contribution, 4),
            'contribution_PR': round(pr_contribution, 4),
            # Relative contributions
            'relative_contribution_WI_pct': round(wi_rel, 2),
            'relative_contribution_C_pct': round(c_rel, 2),
            'relative_contribution_PR_pct': round(pr_rel, 2),
            # Pixel counts
            'water_pixels': water_pixels,
            'plant_pixels': plant_pixels,
            'total_pixels': int(total_pixels),
            'water_pct': round(water_pct, 2),
            'plant_pct': round(plant_pct, 2),
            # Classes found
            'n_water_classes': len(water_classes_found),
            'n_plant_classes': len(plant_classes_found),
            'water_classes_found': sorted_water,
            'plant_classes_found': sorted_plant
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
def interpret_bea_vis(sv: float) -> str:
    """
    Interpret the Visual Beauty Score.
    
    Args:
        sv: Scenic View score
        
    Returns:
        str: Qualitative interpretation
    """
    if sv is None:
        return "Unable to interpret (no data)"
    elif sv < 1.2:
        return "Low aesthetic appeal"
    elif sv < 1.5:
        return "Below average aesthetic appeal"
    elif sv < 2.0:
        return "Moderate aesthetic appeal"
    elif sv < 2.5:
        return "Above average aesthetic appeal"
    elif sv < 3.0:
        return "Good aesthetic appeal"
    elif sv < 3.5:
        return "High aesthetic appeal"
    else:
        return "Very high aesthetic appeal"


def explain_formula() -> str:
    """
    Provide educational explanation of the BEA_VIS formula.
    
    Returns:
        str: Explanation text
    """
    return """
    Visual Beauty Score (BEA_VIS) Formula:
    
    SV = 1.04165 + 2.00634 × WI + 0.49522 × C + 0.23200 × PR
    
    Where:
        SV = Scenic View (Visual Beauty Score)
        WI = Water Index (water pixels / total pixels)
        C = Color Tone (colorfulness measure, 0-1)
        PR = Plant Richness (plant pixels / total pixels)
    
    Coefficient Analysis:
    
    1. Intercept (1.04165):
       - Base aesthetic value
       - Minimum score when WI=C=PR=0
    
    2. Water Index (coefficient 2.00634):
       - HIGHEST weight in the formula
       - Water has strongest positive impact on perceived beauty
       - Even small amounts of water significantly boost scores
       - Example: WI=0.1 → adds 0.20 to score
    
    3. Color Tone (coefficient 0.49522):
       - MODERATE weight
       - Colorful scenes are perceived as more beautiful
       - Measured using colorfulness/saturation metrics
       - Example: C=0.5 → adds 0.25 to score
    
    4. Plant Richness (coefficient 0.23200):
       - LOWER weight (but still positive)
       - Green vegetation contributes to aesthetic appeal
       - Less impactful than water or color
       - Example: PR=0.3 → adds 0.07 to score
    
    Score Interpretation:
    - SV ≈ 1.0-1.5: Low aesthetic appeal (urban, gray)
    - SV ≈ 1.5-2.0: Moderate appeal (some greenery)
    - SV ≈ 2.0-2.5: Good appeal (vegetation + color)
    - SV ≈ 2.5-3.0: High appeal (water + vegetation)
    - SV > 3.0: Very high appeal (water + color + plants)
    
    Research Background:
    This formula is derived from empirical studies correlating 
    visual features with human aesthetic preferences for street scenes.
    The coefficients represent statistically significant predictors 
    of perceived scenic beauty.
    """


# =============================================================================
# STANDALONE TEST (Optional)
# =============================================================================
if __name__ == "__main__":
    import os
    
    print("\nTesting Visual Beauty Score calculator...")
    
    # Test 1: Low beauty (gray urban scene)
    test_img_1 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_1[:, :] = [128, 128, 128]  # Gray (low colorfulness)
    
    test_path_1 = '/tmp/test_bea_vis_1.png'
    Image.fromarray(test_img_1).save(test_path_1)
    
    test_semantic = {
        "sky": (135, 206, 235), 
        "building": (128, 64, 64),
        "tree": (34, 139, 34),
        "grass": (0, 128, 0),
        "water": (0, 0, 128),
        "road": (128, 128, 128)
    }
    result_1 = calculate_indicator(test_path_1, test_semantic)
    
    print(f"\nTest 1: Gray uniform image (low beauty)")
    print(f" Visual Beauty Score: {result_1.get('value', 'N/A')}")
    print(f" WI: {result_1.get('water_index', 'N/A')}, C: {result_1.get('color_tone', 'N/A')}, PR: {result_1.get('plant_richness', 'N/A')}")
    print(f" Interpretation: {interpret_bea_vis(result_1.get('value'))}")
    
    os.remove(test_path_1)
    
    # Test 2: High plants (green scene)
    test_img_2 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_2[:50, :] = [135, 206, 235]  # Sky
    test_img_2[50:, :] = [34, 139, 34]    # Trees (50%)
    
    test_path_2 = '/tmp/test_bea_vis_2.png'
    Image.fromarray(test_img_2).save(test_path_2)
    
    result_2 = calculate_indicator(test_path_2, test_semantic)
    
    print(f"\nTest 2: 50% sky + 50% trees (green scene)")
    print(f" Visual Beauty Score: {result_2.get('value', 'N/A')}")
    print(f" WI: {result_2.get('water_index', 'N/A')}, C: {result_2.get('color_tone', 'N/A')}, PR: {result_2.get('plant_richness', 'N/A')}")
    print(f" PR contribution: {result_2.get('contribution_PR', 'N/A')}")
    print(f" Interpretation: {interpret_bea_vis(result_2.get('value'))}")
    
    os.remove(test_path_2)
    
    # Test 3: Water scene (should have high score)
    test_img_3 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_3[:30, :] = [135, 206, 235]  # Sky (30%)
    test_img_3[30:70, :] = [0, 0, 128]    # Water (40%)
    test_img_3[70:, :] = [34, 139, 34]    # Trees (30%)
    
    test_path_3 = '/tmp/test_bea_vis_3.png'
    Image.fromarray(test_img_3).save(test_path_3)
    
    result_3 = calculate_indicator(test_path_3, test_semantic)
    
    print(f"\nTest 3: 30% sky + 40% water + 30% trees (scenic view)")
    print(f" Visual Beauty Score: {result_3.get('value', 'N/A')}")
    print(f" WI: {result_3.get('water_index', 'N/A')}, C: {result_3.get('color_tone', 'N/A')}, PR: {result_3.get('plant_richness', 'N/A')}")
    print(f" Contributions - WI: {result_3.get('contribution_WI', 'N/A')}, C: {result_3.get('contribution_C', 'N/A')}, PR: {result_3.get('contribution_PR', 'N/A')}")
    print(f" Interpretation: {interpret_bea_vis(result_3.get('value'))}")
    
    os.remove(test_path_3)
    
    # Test 4: Colorful flowers and water
    test_img_4 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_4[:25, :] = [135, 206, 235]   # Sky (25%)
    test_img_4[25:50, :] = [255, 0, 128]   # Flowers/colorful (25%)
    test_img_4[50:75, :] = [0, 0, 128]     # Water (25%)
    test_img_4[75:, :] = [34, 139, 34]     # Trees (25%)
    
    test_path_4 = '/tmp/test_bea_vis_4.png'
    Image.fromarray(test_img_4).save(test_path_4)
    
    result_4 = calculate_indicator(test_path_4, test_semantic)
    
    print(f"\nTest 4: Colorful scene (sky, flowers, water, trees)")
    print(f" Visual Beauty Score: {result_4.get('value', 'N/A')}")
    print(f" WI: {result_4.get('water_index', 'N/A')}, C: {result_4.get('color_tone', 'N/A')}, PR: {result_4.get('plant_richness', 'N/A')}")
    print(f" Saturation: {result_4.get('saturation', 'N/A')}")
    print(f" Interpretation: {interpret_bea_vis(result_4.get('value'))}")
    
    os.remove(test_path_4)
    
    print("\n Test complete!")
    print("\n Formula Coefficients:")
    print(" Intercept: 1.04165 (base value)")
    print(" WI weight: 2.00634 (highest - water has strongest impact)")
    print(" C weight: 0.49522 (moderate - color matters)")
    print(" PR weight: 0.23200 (lower - plants contribute positively)")


# =============================================================================
# LAYER-AWARE CALCULATION (v8.0 — photo-aware colorfulness)
# =============================================================================
#
# v8.0 fix:  The original wrapper called Hasler-Süsstrunk colorfulness on
# the SEMANTIC MAP (a small palette of ADE20K class colours) rather than the
# user's PHOTO, so the C term collapsed to a near-constant ~0.18 across
# every image — every output landed in [1.10, 1.30]. We now read:
#   * semantic_map_path   → for WI (water pixels) and PR (plant pixels)
#   * original_photo_path → for C  (colorfulness on the actual photograph)
#   * mask_path           → restrict both to the spatial layer (FG/MG/BG)
#
def calculate_for_layer(semantic_map_path, mask_path=None,
                        original_photo_path=None):
    """v8.0 — layer-aware Visual Beauty Score.

    Reads:
        * semantic_map_path   for WI (water pixels) and PR (plant pixels)
        * original_photo_path for C  (Hasler-Süsstrunk colourfulness on
                                       the actual photograph)
        * mask_path           restricts both to a spatial layer (FG/MG/BG)

    When original_photo_path is None we fall back to the semantic-map
    colour space (the legacy degenerate behaviour) so older callers keep
    working — the C term then collapses to ~0.18 and outputs cluster
    tightly around 1.20, which is exactly the bug we're working around
    everywhere downstream now.
    """
    import os

    try:
        sem_img = Image.open(semantic_map_path).convert("RGB")
        sem_arr = np.array(sem_img)
        H, W, _ = sem_arr.shape

        if mask_path and os.path.exists(mask_path):
            with Image.open(mask_path) as m:
                m = m.convert("L")
                if m.size != (W, H):
                    m = m.resize((W, H), Image.NEAREST)
                mask_arr = np.array(m) > 127
        else:
            mask_arr = np.ones((H, W), dtype=bool)

        try:
            from input_layer import semantic_colors  # injected by orchestrator
        except Exception:
            semantic_colors = None
        water_mask = np.zeros((H, W), dtype=bool)
        plant_mask = np.zeros((H, W), dtype=bool)
        if semantic_colors:
            for class_name, rgb in semantic_colors.items():
                px = np.all(sem_arr == np.array(rgb, dtype=np.uint8), axis=2)
                if not px.any():
                    continue
                if is_water_class(class_name):
                    water_mask |= px
                elif is_plant_class(class_name):
                    plant_mask |= px
        water_mask &= mask_arr
        plant_mask &= mask_arr
        mask_pixels = int(np.sum(mask_arr))
        if mask_pixels == 0:
            return {"success": True,
                    "value": float(INDICATOR["coefficients"]["intercept"]),
                    "water_index": 0.0, "plant_richness": 0.0, "color_tone": 0.0}
        wi = float(np.sum(water_mask)) / mask_pixels
        pr = float(np.sum(plant_mask)) / mask_pixels

        photo_for_color = original_photo_path or semantic_map_path
        try:
            photo_img = Image.open(photo_for_color).convert("RGB")
            if photo_img.size != (W, H):
                photo_img = photo_img.resize((W, H), Image.BILINEAR)
            photo_arr = np.array(photo_img)
        except Exception:
            photo_arr = sem_arr
        layer_pixels = photo_arr[mask_arr]
        if layer_pixels.size == 0:
            c = 0.0
        else:
            R = layer_pixels[:, 0].astype(np.float64)
            G = layer_pixels[:, 1].astype(np.float64)
            B = layer_pixels[:, 2].astype(np.float64)
            rg = R - G
            yb = 0.5 * (R + G) - B
            sigma = np.sqrt(np.var(rg) + np.var(yb))
            mu = np.sqrt(rg.mean() ** 2 + yb.mean() ** 2)
            c = min(1.0, (sigma + 0.3 * mu) / 100.0)

        coef = INDICATOR["coefficients"]
        sv = (coef["intercept"]
              + coef["WI"] * wi
              + coef["C"] * c
              + coef["PR"] * pr)
        return {
            "success": True,
            "value": round(float(sv), 4),
            "water_index": round(wi, 4),
            "color_tone": round(c, 4),
            "plant_richness": round(pr, 4),
            "contribution_WI": round(coef["WI"] * wi, 4),
            "contribution_C":  round(coef["C"] * c, 4),
            "contribution_PR": round(coef["PR"] * pr, 4),
            "target_pixels": mask_pixels,
            "total_pixels": int(H * W),
        }
    except Exception as e:
        return {"success": False, "value": None,
                "error": f"BEA_VIS layer wrapper failed: {e}"}

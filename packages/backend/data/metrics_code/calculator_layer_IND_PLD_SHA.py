"""Calculator Layer.

Indicator ID:   IND_PLD_SHA
Indicator Name: Plant Diversity — Shannon entropy
Type:           TYPE A (ratio mode)

Description:
    Shannon entropy H' over plant-class proportions.

Formula: 

NOTE: This is a stub calculator created during V1 schema sync to align
with KB Q-stage split decision (IND_PLD → RIC/SHA/SIM). The actual
diversity-index implementation should follow standard ecological metrics:
  - RIC: Richness = count of distinct semantic classes present
  - SHA: Shannon diversity H' = -Σ p_i × ln(p_i)
  - SIM: Simpson diversity D = 1 - Σ p_i²

  where p_i = fraction of pixels belonging to class i.
"""

import numpy as np
from PIL import Image
from typing import Dict


INDICATOR = {
    "id": "IND_PLD_SHA",
    "name": "Plant Diversity — Shannon entropy",
    "unit": "nats or bits (dimensionless)",
    "formula": "",
    "target_direction": "INCREASE",
    "definition": "Shannon entropy H' over plant-class proportions.",
    "category": "",
    "calc_type": "ratio",
    "target_classes": [],
}


print(f"\nCalculator loaded: {INDICATOR['id']} - {INDICATOR['name']}")


def calculate_indicator(image_path: str) -> Dict:
    """Plant Diversity index — restrict to vegetation classes only.

    v8.0 fix: the original implementation called np.unique on every pixel
    in the semantic map, which counted SKY / ROAD / BUILDING etc. toward
    "plant diversity". We now mask the semantic map to vegetation
    classes (tree / grass / plant / palm / flower) before computing
    richness / Shannon / Simpson, so the values actually reflect how
    diverse the *plant* community is.
    """
    try:
        img = Image.open(image_path).convert("RGB")
        sem = np.array(img)
        H, W, _ = sem.shape
        total = H * W
        if total == 0:
            return {"success": False, "error": "Empty image", "value": None}

        # Build a vegetation-only mask from semantic_colors.
        plant_keywords = (
            "tree", "trees", "grass", "lawn", "plant", "plants",
            "flora", "leaf", "leaves", "foliage", "flower", "bush",
            "shrub", "palm", "garden",
        )
        sc = globals().get("semantic_colors") or {}
        plant_palette = []
        for cname, rgb in sc.items():
            cn_low = cname.lower().replace("-", " ").replace("_", " ")
            if any(kw in cn_low for kw in plant_keywords):
                plant_palette.append((tuple(rgb), cname))
        if not plant_palette:
            return {"success": True, "value": 0.0,
                    "class_count": 0, "total_pixels": int(total),
                    "note": "no vegetation classes found in palette"}

        # Count pixels per plant class.
        counts = {}
        for rgb, cname in plant_palette:
            mask = np.all(sem == np.array(rgb, dtype=np.uint8), axis=-1)
            n = int(np.sum(mask))
            if n > 0:
                counts[cname] = n
        if not counts:
            return {"success": True, "value": 0.0,
                    "class_count": 0, "total_pixels": int(total),
                    "note": "no vegetation pixels in this image"}

        total_plant = sum(counts.values())
        proportions = np.array(list(counts.values()), dtype=float) / total_plant

        ind_id = INDICATOR["id"]
        if ind_id.endswith("_RIC"):
            value = len(counts)
            metric = "richness (plant class count)"
        elif ind_id.endswith("_SHA"):
            p = proportions[proportions > 0]
            value = float(-np.sum(p * np.log(p)))
            metric = "Shannon H (plant)"
        elif ind_id.endswith("_SIM"):
            value = float(1 - np.sum(proportions ** 2))
            metric = "Simpson 1-D (plant)"
        else:
            return {"success": False,
                    "error": f"Unknown variant: {ind_id}", "value": None}

        return {
            "success": True,
            "value": round(float(value), 4),
            "metric": metric,
            "class_count": int(len(counts)),
            "total_plant_pixels": int(total_plant),
            "total_pixels": int(total),
            "plant_breakdown": counts,
        }
    except FileNotFoundError:
        return {"success": False,
                "error": f"Image not found: {image_path}", "value": None}
    except Exception as e:
        return {"success": False, "error": str(e), "value": None}

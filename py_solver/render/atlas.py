"""Sprite atlas loading: crops per-frame sprites out of the packed sheet."""

import json
from pathlib import Path
from typing import Any, Dict, Optional

from PIL import Image

# The atlas is the web app's, not a second copy: py_solver/ sits inside the
# repo, so it reads public/data/ directly. Keeping a private copy under
# render/assets/ meant a repack could silently leave the two renderers drawing
# different sprites -- and cost 1.6MB of duplicated art in git.
REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS_DIR = REPO_ROOT / "public" / "data"
ATLAS_JSON_PATH = ASSETS_DIR / "web_atlas.json"
ATLAS_IMAGE_PATH = ASSETS_DIR / "web_atlas.webp"


class TextureAtlas:
    def __init__(
        self,
        json_path: Path = ATLAS_JSON_PATH,
        image_path: Path = ATLAS_IMAGE_PATH,
    ):
        self.json_path = json_path
        self.image_path = image_path
        self.textures: Dict[str, Dict[str, Any]] = {}
        self._load()

    def _load(self):
        for path in (self.json_path, self.image_path):
            if not path.exists():
                raise FileNotFoundError(f"Atlas missing at {path}")

        with open(self.json_path, "r", encoding="utf-8") as f:
            atlas_data = json.load(f)

        sheet = Image.open(self.image_path).convert("RGBA")
        frames = atlas_data.get("frames", {})

        if isinstance(frames, list):
            frames = {f["filename"]: f for f in frames}

        for frame_name, info in frames.items():
            f_box = info["frame"]
            x, y, w, h = f_box["x"], f_box["y"], f_box["w"], f_box["h"]

            # Look up 'anchor' first, fall back to 'pivot', default to center
            anchor = info.get("anchor") or info.get("pivot") or {"x": 0.5, "y": 0.5}

            self.textures[frame_name] = {
                "image": sheet.crop((x, y, x + w, y + h)),
                "anchor": (anchor["x"], anchor["y"]),
                "ptu": float(info.get("pixelsToUnits", 256.0)),
            }

    def get_texture(self, frame_name: str) -> Optional[Dict[str, Any]]:
        return self.textures.get(frame_name)

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import io

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None


BBox = tuple[float, float, float, float]


@dataclass
class VisionRouterConfig:
    max_dim: int = 800
    color_quantize: int = 20
    min_block_ratio: float = 0.01



class VisionRouter:
    """Compute bbox ratios after removing large solid-color connected regions."""

    def __init__(self, config: VisionRouterConfig | None = None) -> None:
        self.config = config or VisionRouterConfig()

    def run(self, image: Path | bytes | "np.ndarray", bboxes: Sequence[BBox]) -> dict[str, float]:
        if np is None:
            raise ImportError("numpy is required for VisionRouter.")

        img = self._load_image(image)
        orig_h, orig_w = img.shape[:2]
        if orig_h <= 0 or orig_w <= 0:
            return {
                "white_ratio": 0.0,
                "effective_area_ratio": 1.0,
                "bbox_ratio_effective": 0.0,
                "bbox_ratio_total": 0.0,
            }

        scale = min(1.0, self.config.max_dim / max(orig_w, orig_h))
        if scale < 1.0:
            img = self._downsample(img, scale)

        h, w = img.shape[:2]
        total_pixels = h * w
        if total_pixels <= 0:
            return {
                "white_ratio": 0.0,
                "effective_area_ratio": 1.0,
                "bbox_ratio_effective": 0.0,
                "bbox_ratio_total": 0.0,
            }

        rgb = img[:, :, :3] if img.shape[2] >= 3 else np.repeat(img[:, :, :1], 3, axis=2)
        q = max(1, int(self.config.color_quantize))
        r = (rgb[:, :, 0] // q).astype(np.int32)
        g = (rgb[:, :, 1] // q).astype(np.int32)
        b = (rgb[:, :, 2] // q).astype(np.int32)
        color_labels = (r << 16) | (g << 8) | b

        exclude_mask = np.zeros_like(color_labels, dtype=bool)
        if bboxes:
            sx = w / orig_w
            sy = h / orig_h
            for x0, y0, x1, y1 in bboxes:
                px0 = int(max(0, min(w, x0 * sx)))
                py0 = int(max(0, min(h, y0 * sy)))
                px1 = int(max(0, min(w, x1 * sx)))
                py1 = int(max(0, min(h, y1 * sy)))
                if px1 <= px0 or py1 <= py0:
                    continue
                exclude_mask[py0:py1, px0:px1] = True

        solid_pixels = self._count_solid_blocks(color_labels, exclude_mask, total_pixels)
        effective_pixels = max(0, total_pixels - solid_pixels)

        bbox_pixels = self._sum_bbox_area(bboxes, orig_w, orig_h, w, h)
        bbox_ratio_total = (bbox_pixels / total_pixels) if total_pixels > 0 else 0.0
        bbox_ratio_effective = (bbox_pixels / effective_pixels) if effective_pixels > 0 else 0.0

        return {
            "white_ratio": (solid_pixels / total_pixels) if total_pixels > 0 else 0.0,
            "effective_area_ratio": (effective_pixels / total_pixels) if total_pixels > 0 else 0.0,
            "bbox_ratio_effective": bbox_ratio_effective,
            "bbox_ratio_total": bbox_ratio_total,
        }

    def _load_image(self, image: Path | bytes | "np.ndarray") -> "np.ndarray":
        if np is None:
            raise ImportError("numpy is required for VisionRouter.")

        if isinstance(image, Path):
            if Image is None:
                raise ImportError("Pillow is required to load image paths.")
            with Image.open(image) as im:
                im = im.convert("RGB")
                return np.array(im)
        if isinstance(image, (bytes, bytearray)):
            if Image is None:
                raise ImportError("Pillow is required to load image bytes.")
            with Image.open(io.BytesIO(image)) as im:
                im = im.convert("RGB")
                return np.array(im)
        if hasattr(image, "shape"):
            return image
        raise TypeError("Unsupported image input type.")

    def _downsample(self, img: "np.ndarray", scale: float) -> "np.ndarray":
        if Image is not None:
            pil = Image.fromarray(img.astype("uint8"), mode="RGB")
            new_w = max(1, int(pil.width * scale))
            new_h = max(1, int(pil.height * scale))
            pil = pil.resize((new_w, new_h), resample=Image.BILINEAR)
            return np.array(pil)

        h, w = img.shape[:2]
        new_h = max(1, int(h * scale))
        new_w = max(1, int(w * scale))
        ys = np.linspace(0, h - 1, new_h).astype(int)
        xs = np.linspace(0, w - 1, new_w).astype(int)
        return img[ys][:, xs]

    def _count_solid_blocks(
        self,
        color_labels: "np.ndarray",
        exclude_mask: "np.ndarray",
        total_pixels: int,
    ) -> int:
        min_block_size = int(total_pixels * self.config.min_block_ratio)
        visited = np.zeros_like(color_labels, dtype=bool)
        height, width = color_labels.shape
        solid_pixels = 0

        for y in range(height):
            for x in range(width):
                if visited[y, x]:
                    continue
                label = color_labels[y, x]
                stack = [(y, x)]
                visited[y, x] = True
                count = 0
                overlap_count = 0
                while stack:
                    cy, cx = stack.pop()
                    count += 1
                    if exclude_mask[cy, cx]:
                        overlap_count += 1
                    if cy > 0 and color_labels[cy - 1, cx] == label and not visited[cy - 1, cx]:
                        visited[cy - 1, cx] = True
                        stack.append((cy - 1, cx))
                    if cy + 1 < height and color_labels[cy + 1, cx] == label and not visited[cy + 1, cx]:
                        visited[cy + 1, cx] = True
                        stack.append((cy + 1, cx))
                    if cx > 0 and color_labels[cy, cx - 1] == label and not visited[cy, cx - 1]:
                        visited[cy, cx - 1] = True
                        stack.append((cy, cx - 1))
                    if cx + 1 < width and color_labels[cy, cx + 1] == label and not visited[cy, cx + 1]:
                        visited[cy, cx + 1] = True
                        stack.append((cy, cx + 1))

                if count >= min_block_size:
                    solid_pixels += max(0, count - overlap_count)

        return solid_pixels

    def _sum_bbox_area(
        self,
        bboxes: Sequence[BBox],
        orig_w: int,
        orig_h: int,
        w: int,
        h: int,
    ) -> float:
        if not bboxes:
            return 0.0
        sx = w / orig_w
        sy = h / orig_h
        area = 0.0
        for x0, y0, x1, y1 in bboxes:
            px0 = max(0.0, min(w, x0 * sx))
            py0 = max(0.0, min(h, y0 * sy))
            px1 = max(0.0, min(w, x1 * sx))
            py1 = max(0.0, min(h, y1 * sy))
            if px1 <= px0 or py1 <= py0:
                continue
            area += (px1 - px0) * (py1 - py0)
        return area

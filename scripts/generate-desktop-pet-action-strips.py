#!/usr/bin/env python3
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src/desktop-pet/assets/robo-buddy-extended-18-row-atlas.png"
OUT = ROOT / "src/desktop-pet/assets/actions"
SOURCE_FRAME_ROOT = ROOT / "src/desktop-pet/assets/action-source-frames"
CELL_W = 192
CELL_H = 208
FRAME_W = 256
FRAME_H = 240
FRAME_X = (FRAME_W - CELL_W) // 2
FRAME_Y = (FRAME_H - CELL_H) // 2
GUTTER = 24

ROWS = [
    ("idle", 0, 6),
    ("running-right", 1, 8),
    ("running-left", 2, 8),
    ("waving", 3, 4),
    ("jumping", 4, 5),
    ("failed", 5, 8),
    ("waiting", 6, 6),
    ("running", 7, 6),
    ("review", 8, 6),
    ("desk-work", 9, 8),
    ("checklist-review", 10, 8),
    ("idea-thinking", 11, 8),
    ("code-explain", 12, 8),
    ("tired-seated", 13, 8),
    ("side-sleep", 14, 8),
    ("plug-charging", 15, 8),
    ("alert-surprise", 16, 8),
    ("exercise-motion", 17, 8),
]

SAFE_SOURCE_OVERRIDES = {
    # These source rows include foreground props that partially cover the robot.
    # Desktop-pet variants keep the action slot but use unobstructed robot poses.
    "checklist-review": ("jumping", 4, 5),
    "code-explain": ("waving", 3, 4),
}


def atlas_frame(atlas: Image.Image, row: int, frame_index: int, source_frames: int) -> Image.Image:
    left = (frame_index % source_frames) * CELL_W
    top = row * CELL_H
    return atlas.crop((left, top, left + CELL_W, top + CELL_H))


def source_frame_paths(state: str) -> list[Path]:
    source_dir = SOURCE_FRAME_ROOT / state
    if not source_dir.is_dir():
        return []
    return sorted(source_dir.glob("*.png"))


def normalize_frame(frame: Image.Image) -> Image.Image:
    if frame.size == (CELL_W, CELL_H):
        return frame
    normalized = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    x = (CELL_W - frame.width) // 2
    y = (CELL_H - frame.height) // 2
    normalized.paste(frame, (x, y), frame)
    return normalized


def clean_edge_fragments(frame: Image.Image) -> Image.Image:
    alpha = frame.getchannel("A")
    pixels = alpha.load()
    seen = set()
    components: list[tuple[int, list[tuple[int, int]]]] = []

    for y in range(CELL_H):
        for x in range(CELL_W):
            if pixels[x, y] <= 8 or (x, y) in seen:
                continue

            queue = deque([(x, y)])
            seen.add((x, y))
            component = []
            min_x = max_x = x
            min_y = max_y = y

            while queue:
                cx, cy = queue.popleft()
                component.append((cx, cy))
                min_x = min(min_x, cx)
                max_x = max(max_x, cx)
                min_y = min(min_y, cy)
                max_y = max(max_y, cy)

                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if nx < 0 or nx >= CELL_W or ny < 0 or ny >= CELL_H:
                        continue
                    if (nx, ny) in seen or pixels[nx, ny] <= 8:
                        continue
                    seen.add((nx, ny))
                    queue.append((nx, ny))

            components.append((len(component), component))

    cleaned = frame.copy()
    keep = Image.new("L", frame.size, 0)
    keep_pixels = keep.load()
    if components:
        _area, largest = max(components, key=lambda item: item[0])
        for px, py in largest:
            keep_pixels[px, py] = pixels[px, py]
    cleaned.putalpha(keep)
    return cleaned


def draw_laptop(draw: ImageDraw.ImageDraw, bob: int) -> None:
    screen = [(198, 114 + bob), (234, 111 + bob), (237, 135 + bob), (201, 140 + bob)]
    base = [(194, 143 + bob), (238, 136 + bob), (244, 148 + bob), (199, 156 + bob)]
    screen_inner = [(202, 118 + bob), (230, 116 + bob), (232, 132 + bob), (204, 136 + bob)]

    for width, color in ((7, (8, 15, 18, 255)), (4, (28, 46, 48, 255))):
        draw.line(screen + [screen[0]], fill=color, width=width, joint="curve")
        draw.line(base + [base[0]], fill=color, width=width, joint="curve")
    draw.polygon(screen, fill=(45, 177, 168, 255))
    draw.polygon(screen_inner, fill=(25, 92, 95, 255))
    draw.polygon(base, fill=(17, 42, 45, 255))

    draw.line([(207, 123 + bob), (219, 122 + bob)], fill=(103, 232, 224, 230), width=2)
    draw.line([(209, 128 + bob), (226, 126 + bob)], fill=(242, 201, 105, 230), width=2)
    draw.line([(208, 133 + bob), (222, 131 + bob)], fill=(103, 232, 224, 210), width=2)
    draw.rounded_rectangle((222, 123 + bob, 230, 130 + bob), radius=2, fill=(242, 201, 105, 255), outline=(119, 78, 16, 255), width=2)
    draw.line([(204, 150 + bob), (234, 146 + bob)], fill=(92, 123, 124, 220), width=2)


def render_desk_work_frame(atlas: Image.Image, frame_index: int) -> Image.Image:
    frame = clean_edge_fragments(atlas_frame(atlas, 0, frame_index, 6))
    canvas = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    canvas.paste(frame, (FRAME_X, FRAME_Y), frame)
    draw_laptop(ImageDraw.Draw(canvas), (frame_index % 4) - 1)
    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    atlas = Image.open(SRC).convert("RGBA")
    frame_stride = FRAME_W + GUTTER * 2

    for state, row, frames in ROWS:
        independent_frames = source_frame_paths(state)
        _source_state, source_row, source_frames = SAFE_SOURCE_OVERRIDES.get(state, (state, row, frames))
        strip = Image.new("RGBA", (frame_stride * frames, FRAME_H), (0, 0, 0, 0))
        for frame_index in range(frames):
            if state == "desk-work":
                canvas = render_desk_work_frame(atlas, frame_index)
            elif independent_frames:
                frame_path = independent_frames[frame_index % len(independent_frames)]
                frame = normalize_frame(Image.open(frame_path).convert("RGBA"))
                frame = clean_edge_fragments(frame)
                canvas = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
                canvas.paste(frame, (FRAME_X, FRAME_Y), frame)
            else:
                frame = clean_edge_fragments(atlas_frame(atlas, source_row, frame_index, source_frames))
                canvas = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
                canvas.paste(frame, (FRAME_X, FRAME_Y), frame)
            strip.paste(canvas, (frame_index * frame_stride + GUTTER, 0))
        strip.save(OUT / f"{state}.png")


if __name__ == "__main__":
    main()

"""Encode a GIF from verified Lottie browser frames, without redrawing artwork."""
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
report = json.loads((ROOT / "qa/validation.json").read_text(encoding="utf-8"))
folder = Path(report["previewFrameDirectory"])
def read_frame(p, width=None, square=False):
    with Image.open(p) as source:
        frame = source.convert("RGB")
    if square:
        edge = min(frame.size)
        left, top = (frame.width-edge)//2, (frame.height-edge)//2
        frame = frame.crop((left, top, left+edge, top+edge))
    if width:
        frame = frame.resize((width, round(frame.height*width/frame.width)), Image.Resampling.LANCZOS)
    return frame

frames = [read_frame(p, width=840) for p in sorted(folder.glob("[0-9]*.png"))]
assert len(frames) == 216
# GIF delays have 10ms precision; 30/30/40ms keeps a 30fps average.
frames[0].save(ROOT / "preview.gif", save_all=True, append_images=frames[1:],
               duration=[30, 30, 40] * 72, loop=0, disposal=2, optimize=False)
idle = [read_frame(p, width=512, square=True) for p in sorted(folder.glob("idle_*.png"))]
assert len(idle) == 108
idle[0].save(ROOT / "idle_breath_preview.gif", save_all=True, append_images=idle[1:], duration=[30,30,40]*36, loop=0, disposal=2, optimize=False)
for frame in frames:
    frame.close()
for frame in idle:
    frame.close()
for p in folder.glob("*.png"):
    p.unlink()
folder.rmdir()
report.pop("previewFrameDirectory")
report["gifDurationMs"] = 7200
report["gifSource"] = "lottie-web 5.12.2 / Chromium SVG renderer"
(ROOT / "qa/validation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print("Exported 7.2s four-state preview and 3.6s water-breathing GIF from the actual Lottie player.")

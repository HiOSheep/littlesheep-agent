"""Lossless WebP playback assets from the approved, baked light field."""
from pathlib import Path
from PIL import Image
import sys

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT.parents[2] / "app/resources/void-ring"
DEST.mkdir(parents=True, exist_ok=True)

def verify_alpha(frame):
    for point in [(0,0),(frame.width-1,0),(0,frame.height-1),(frame.width-1,frame.height-1)]:
        assert frame.getpixel(point)[3] == 0, "surface corners must be transparent"
    center = frame.getpixel((round(frame.width*480/1024),round(frame.height*530/1024)))
    assert center[3] == 255 and max(center[:3]) < 24, "black sphere must remain opaque"

def export_startup(frames):
    small = [frame.resize((128,128), Image.Resampling.LANCZOS) for frame in frames]
    small[0].save(DEST / "startup.webp", save_all=True, append_images=small[1:], duration=[33,33,34]*36, loop=0, lossless=True, method=4)
    for frame in small:
        verify_alpha(frame)

if "--startup-only" in sys.argv:
    with Image.open(DEST / "idle_breath.webp") as source:
        frames = []
        for i in range(source.n_frames):
            source.seek(i)
            frames.append(source.convert("RGBA"))
    export_startup(frames)
    print("Exported standalone 128px startup motion")
    sys.exit(0)
size = 384
body = Image.open(ROOT / "motion/sphere_foreground.png").convert("RGBA").resize((size,size), Image.Resampling.LANCZOS)
with Image.open(ROOT / "icon/sphere_motion_source.png") as source:
    mark = source.convert("RGBA")
    verify_alpha(mark)
    mark.save(DEST / "mark.png")
for name, count in [("idle_breath",108),("loading_orbit",60),("thinking_pulse",96)]:
    frames = []
    for path in sorted((ROOT / "motion/fluid_frames" / name).glob("*.png")):
        with Image.open(path) as source:
            light = source.convert("RGBA")
        frame = Image.alpha_composite(body, light)
        verify_alpha(frame)
        frames.append(frame)
    assert len(frames) == count
    target = DEST / (name + ".webp")
    frames[0].save(target, save_all=True, append_images=frames[1:], duration=[33,33,34]*(count//3), loop=0, lossless=True, method=6)
    with Image.open(target) as check:
        assert check.n_frames == count
        total = 0
        for i in range(count):
            check.seek(i)
            check.load()
            verify_alpha(check.convert("RGBA"))
            total += check.info["duration"]
        assert total == count*1000//30
    print(name, count, "transparent frames;", target.stat().st_size, "bytes", flush=True)
    if name == "idle_breath":
        export_startup(frames)

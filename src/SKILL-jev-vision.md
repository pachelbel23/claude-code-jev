---
name: jev-vision
description: Ask TypeSafe Jev typed questions about image files on disk — yes/no (Noul), pick-one (Choice), or where-is-it (Box bounding box) — via `node ~/.claude/jev/jev-vision.mjs`. Use when a script or batch needs cheap, repeatable judgments over many PNG/JPEG files (sort photos, check a label or screenshot, find and crop a region), or when precise bounding-box coordinates are needed. Not for describing an image in prose, and not for one-off looks at a single image you can read yourself.
---

# Jev Vision

A command-line wrapper around TypeSafe's experimental image support (`TypeSafe-Danger-Zone-Images: true`). It returns **typed answers with probabilities**, not prose.

## When to use it (and when not)

Use it when:
- **Many files**: classify, filter or sort dozens or hundreds of photos and screenshots inside a script. It is cheaper and more repeatable than reading every image yourself.
- **Coordinates**: you need a bounding box in pixels to crop or annotate. Box is better at this than eyeballing.
- **Thresholds**: the caller wants a probability it can threshold, such as "flag if < 0.8".

Do not use it when:
- **One image, one look**: just Read the image yourself.
- **Prose answers**: the user wants a description, OCR text, or reasoning. Jev answers only yes/no, a choice, or a box.
- **Sensitive images**: client NDA material, device photos under test, IDs, or anything personal. Images are **uploaded to TypeSafe**, so ask the user first.
- **Decisions of record**, such as a pass/fail verdict, money, or security gating. TypeSafe calls this feature *Dreamer-ready*, not production. Present results as suggestions for a human to confirm.

## Commands

```bash
node ~/.claude/jev/jev-vision.mjs ask    <img...> "<yes/no question>"
node ~/.claude/jev/jev-vision.mjs choose <img...> "<question>" key="description" key="description" ...
node ~/.claude/jev/jev-vision.mjs box    <img>    "<target, e.g. the product label>"
#   --model <id>  (default: jev-latest for ask/choose, jev-1.14.0 for box)
#   --json        (raw API response)
```

- With several images, they are named `img1`, `img2`, …, in argument order. Refer to them in backticks, e.g. "Is the device in \`img1\` the same model as in \`img2\`?"
- `box` asks a Noul ("is it there?") before the Box. **A Box always returns a box**, so ignore it when the presence probability is low.
- Pixel coordinates refer to the original file when the image was only resized. If the tool rotated the image upright for EXIF orientation, they refer to the upright version.

## Writing good questions

- **One simple question per call.** Jev is weaker on images than on text, so break the task down. Ask "Is there a USB port?" and "Is there an RJ45 port?" separately, not "List the ports".
- **Choice options**: use short keys plus a clear description. Include a catch-all option such as `other="None of the above"`.
- **Small targets in big images**: Box can miss them. Crop to a region first, then box again on the crop.

## Limits (handled automatically where possible)

- **Format**: PNG or JPEG, still images only. Convert GIF, WebP and HEIC first.
- **Size**: each side must be 280–1568 px. The tool resizes automatically using System.Drawing on Windows/WSL, ImageMagick `magick`, or `sips` on macOS. It errors only when no such tool exists.
- **EXIF orientation**: the API ignores it. The tool rotates the image upright when it can, and otherwise warns.
- **Cost**: every image counts as input tokens at the normal price.
- **Key**: `TYPESAFE_API_KEY`, or the key file `~/.claude/jev/api_key`.

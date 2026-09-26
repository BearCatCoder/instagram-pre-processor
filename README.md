# Instagram Pre-Processor

An OpenCode V2 plugin that uses model vision and Adobe Photoshop to prepare JPEG images for square Instagram posts on Windows.

## Install and use

Install this directory as `.opencode/plugins/instagram-pre-processor`, restart OpenCode, then run:

```text
/instagram-pre-processor C:\absolute\path\to\jpegs
```

The plugin scans the selected folder non-recursively for `.jpg` and `.jpeg` files. For each image, it reads available metadata, queues a temporary visual preview, and asks the selected vision model to choose image-specific edits and post text.

Outputs are saved as:

```text
<source folder>\Instagram\<original name>-Insta.jpg
```

Source JPEGs are never modified. Existing outputs are skipped by default. The underlying `instagram_pre_processor_start` tool also accepts `overwrite: true`.

## Processing

Each output is:

- straightened when the horizon, architecture, or subject is unintentionally tilted;
- left skewed when the angle appears purposeful;
- cropped around the AI-selected focal point to an exact 1:1 composition;
- adjusted in Photoshop with Exposure, Brightness/Contrast, Levels, Curves, Color Balance, Vibrance, and Hue/Saturation;
- converted to sRGB when the Photoshop profile is available;
- resized to 1080×1080 pixels; and
- saved as a maximum-quality baseline JPEG.

The model uses visible content and source Title, Description, Extended Description, keywords, creator, copyright, location, and GPS metadata when available. It generates a truthful Instagram caption and relevant discovery hashtags, then writes the combined text to the IPTC Core `ExtDescrAccessibility` XMP property shown by compatible software as **Extended Description (Accessibility)**. Other inherited metadata is preserved by Photoshop's Save As operation.

No system can guarantee that a post will trend. The workflow directs the model to favor current, specific, relevant hashtags and avoid unrelated or spam-like tags.

## Configuration

The default model is `openai/gpt-6-luna`, with `openai/gpt-5.6-terra` as a fallback. Select another model before restarting OpenCode:

```powershell
$env:INSTAGRAM_PRE_PROCESSOR_MODEL = "openai/gpt-5.6-terra"
opencode service restart
```

The equivalent plugin option is `model`.

## Requirements

- Windows
- Adobe Photoshop with AdobeXMPScript
- An OpenCode model with image understanding

Photoshop remains visible during automation. Do not interact with it while a batch is active.

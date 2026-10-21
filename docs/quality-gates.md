# Understanding the generated PSD

[日本語版](quality-gates.ja.md)

The CLI reports the first two cumulative levels below after `finalize` or
`repair`. The third level comes from `still2rig-psd motion-qa`, which records the
built-in preview renderer. These levels answer different questions and must not
be shortened to a single “complete” claim.

| Reported level | What was verified | What was not verified |
| --- | --- | --- |
| **Structure checked** | The builder wrote the configured order and read it back, and structural QA passed required layers, visible pixels, and critical front/back relationships. This corresponds to `structuralPass=true`. Hashes are verified separately by the workflow. | Real blinking, alternate mouth artwork, deformation, and motion quality. |
| **Mouth/closed-eye files checked** | `mouth_open` and `eye_close` are present, are not built-in placeholders, and passed registration and numeric mouth checks. This corresponds to `productionReady=true` in the JSON report. | Whether the drawings are natural, whether the closed-eye lines are good, and whether colors and cutout edges match the face. Despite the field name, this is not a claim that a finished rig is ready for production. |
| **Motion checked by an adapter** | `still2rig-psd motion-qa` recorded the required states in `configs/motion-qa-contract.json` with the built-in preview renderer and every check passed. | Behavior in other renderers, model formats, or poses that were not tested, and whether the motion looks natural. |

A PSD created with `--preview-placeholders` can be **structure checked**, but it
cannot have its **mouth/closed-eye files checked**. A structurally valid PSD is also not
automatically a Live2D model or a finished rig.

## Standard layer order

The default contract uses back-to-front compositing. A later group in this
table is drawn over an earlier group.

| Back to front | Layer names | Reason |
| --- | --- | --- |
| 1 | `back hair` | Remains behind the head and body. |
| 2 | `bottomwear` | Sits behind the upper body layers. |
| 3 | `handwear` | Keeps arms at the sides behind the shirt and shoulder openings. |
| 4 | `topwear` | Covers the inner edge of side-positioned arms. |
| 5 | `neck` | Appears over the body and clothing but under the face. |
| 6 | `ears` | Uses the default Anime2.5-compatible head order. |
| 7 | `face` | Provides the base for all facial features. |
| 8 | `eyewhite`, `irides`, `eyelash`, `eyebrow`, `nose`, `facedetail` | Facial features remain over the face base. |
| 9 | `mouth_close`, `mouth_open`, `eye_close` | Expression states remain over the face base. |
| 10 | `front hair` | Covers the forehead and facial parts that pass behind it. |
| 11 | `headwear` | Remains at the front of the default stack. |

The exact machine-readable order is in `configs/layer-map.json`. Structural QA
also enforces these important relationships:

- `handwear` behind `topwear`;
- `handwear` and `topwear` behind `neck`;
- `neck` behind `face`;
- `eyewhite`, `irides`, `eyelash`, `eyebrow`, `mouth_close`, `mouth_open`, and
  `eye_close` over `face`; and
- `face`, `eyewhite`, `irides`, `mouth_close`, and `eye_close` behind
  `front hair`.

This is a safe default for a front-facing character with arms beside the torso.
It is not a universal order for every pose. If a hand crosses in front of the
shirt, one `handwear` layer cannot be both behind the shoulder opening and in
front of the shirt. That artwork must be split into back and front pieces, or
the PSD contract must be extended. A layer override can replace an existing
layer image, but it cannot add that missing depth split.

A shirt collar is the common case of this problem. See-through draws the whole
neck down into the collar, and `topwear` also holds the inside of the collar
behind the neck. Layer cleanup therefore hides the inferred neck wherever the
source image clearly shows the clothing in front of it. Each overlap pixel goes
to the layer whose colour matches the source better by more than
`neckTuckColorMargin` (sum of RGB differences, default 48). Unclear pixels keep
the neck. Pixels under `face`, `ears`, `front hair`, or `headwear` are skipped,
because there the source shows those layers instead. A supplied `neck.png`
override is never changed. `layer-inspection.json` records the result as
`neckTuck`.

## Images needed for real mouth and eye movement

A neutral source image usually contains open eyes and only one mouth shape. It
does not reveal trustworthy artwork for closed eyes or a different mouth
interior. To verify those states, provide transparent PNG files on the same
canvas and at the same registration as the source:

| File | When it is needed | Content |
| --- | --- | --- |
| `mouth_open.png` | Required for real mouth switching | Only the aligned open-mouth artwork; transparent elsewhere. |
| `eye_close.png` | Required for real blinking | Both aligned closed-eye shapes; transparent elsewhere. |
| `mouth_close.png` | Optional replacement | A corrected closed-mouth drawing when the extracted source mouth is unsuitable. |

Do not include an opaque white or skin-colored rectangle around the mouth. The
mouth files should contain the mouth drawing itself, not a patch copied from the
face. All supplied expression files must match the PSD canvas dimensions.

`--preview-placeholders` may copy the closed mouth into the open-mouth slot so
the WebUI controls can be exercised. It does not generate a real open mouth, so
the two states may look identical and the report remains below expression
file checked.

## Expression requests for image generation

```bash
npm run still2rig-psd -- expression-requests demo
npm run still2rig-psd -- import-expressions demo
npm run still2rig-psd -- repair demo --expressions .still2rig-psd/jobs/demo/generated-expressions
```

`expression-requests` writes `input.png`, `mask.png` and `prompt.txt` for each of
`eye_close` and `mouth_open` under the ignored work directory. The input is a
face crop of the current neutral PSD layer composite, including the latest
repair, rather than the original image whose dimensions may differ. Transparent
mask pixels may change; opaque mask pixels must remain identical.
Small crops use an integer enlargement toward a long side of 1024 pixels,
capped at 4. `requests.json` records the factor; masks and underlays share it.
Layers above the expressions, including front hair and headwear, are hidden in
both the input and the underlay. The generator must not add hair or accessories.
Each variant also has a local `underlay.png` containing the face without that
variant's source eyes or mouth. This reference is used only for extraction;
do not edit it or send it to the generator.

The expanded smiling-eye mask protects eyebrows and front hair with a
4-native-pixel margin. The original eye alpha union, including thin eyelash
tips, retains at least 4 pixels of lateral margin (or the larger configured
dilation). This eye envelope takes precedence over front-hair protection so
that a hair cutout cannot slice through the original lashes; eyebrow protection
still takes precedence. The cheek mask stops 4 native pixels inside the face
alpha contour. Request metadata records these distances.

Ask the image owner before sending these crops to a generation service. Save
the returned images as `expression-requests/results/eye_close.png` and
`mouth_open.png`. `import-expressions JOB [DIR]` accepts another results directory
when supplied. Results must keep aspect-ratio error within 1%. Alignment uses
an 8-native-pixel band outside the editable area (`--protected-band`), with
input alpha at least 240. Uniform scale and subpixel shift are estimated there;
a small preference for shorter transforms avoids unstable fits on smooth skin.
Meaningful drift is compensated only within a 12-pixel displacement magnitude
and 3% scale error (`--max-alignment-shift`, `--max-alignment-scale`). The search
radius is 24 pixels (`--alignment-radius`). The original generator output is
sampled once with the estimated affine transform before extraction. Distances
use original PSD pixels, independently of request enlargement.

The `strict` and `seam` modes both use RGB on a shared white background: alpha 248–249 on almost opaque
skin must not introduce a dark premultiplication error. Reports retain direct
channel-wise mean/p99 for diagnosis. The `strict` gate uses symmetric nearest-color
matching within two native pixels, excluding editable and translucent input
pixels; its outer support extends two pixels beyond the measured band. The
mean/p99 of these per-pixel RGB errors must be at most 6/20
(`--max-outside-mean`, `--max-outside-p99`). Older crops from two real characters
measured 2.66/7.33 and 3.91/5.67, versus 2.33/12.67 and 1.47/12.67 after compensation.
The numeric global limits remain unchanged; the comparison accounts for opacity
encoding and small contour rasterization differences instead of widening them.

Local gates test 4x4 native-pixel tiles with at least 8 band pixels in the opaque
face interior, inset two pixels from its contour. Their maximum mean is 24
(`--max-band-local-mean`), reduced to 12 for reference tiles with channel ranges
at most 24 (`--max-band-flat-mean`). Positive samples measured maxima below 8;
removed/moved brows, painted skin patches and excessive shifts must still fail.
Outer hair silhouettes retain the global band check, but are excluded from face
interior tiles. In `strict` mode, far context is neither measured nor imported. These checks do
not cover every drawing defect; visual review remains required.

`configs/expressions.json` selects `protectedCheck` per expression: `eye_close`
and `mouth_open` use `strict`; `eye_smile` and `blush` use `seam`.
`import-expressions JOB [DIR] --protected-check strict|seam` overrides that
choice for the supplied results. Alignment and provenance checks are identical
in both modes. The outside/band CLI thresholds above apply only to `strict`.

`seam` evaluates the entire non-editable region for large changes: mean RGB
error must be at most 18 and its 99th percentile at most 80. It then checks both
sides of the edit boundary in native PSD pixels. The inner and outer bands are
3 pixels wide; only reference pixels with alpha at least 240 are measured.
A Gaussian blur of radius 1 removes pixel texture before comparing the RGB
residual (generated minus base). The base keeps the original outside the mask
and uses the PSD underlay inside, so intentionally removing the source eye or
mouth is not classified as a seam. Each band's mean must be at most 6 and
95th percentile at most 20. Inside the mask, the maximum mean of 4x4 tiles with
at least 4 band pixels must be at most 12. Outside tile means and their worst
location remain diagnostic values only: pixels outside the mask retain the
original artwork during extraction. `diagnostics.outerTiles` records whether
the diagnostic limit of 12 is exceeded, without affecting the import decision.
For adjoining opaque pixels across the boundary, the 95th
percentile of the difference between residuals must be at most 12. This
subtracts gradients already present in the original. Empty bands or a boundary
without opaque sample pairs fail explicitly. Reports include each band, sample
count, worst tile, limits, and failed checks under `variants.NAME.seam`.

When the finalized PSD matches the requested layer snapshot, `seam` excludes
pixels completely covered by permanent layers in front of the expression.
Coverage uses the PSD's actual layer order, offsets, and alpha exactly 255;
an expression absent from the PSD uses its insertion position in the layer map.
Hidden, translucent, clipped, masked, non-normal, and animated expression
layers do not establish coverage. Grouped PSDs are unsupported. Covered
pixels contribute neither outside error nor boundary samples, and their
residual is zeroed before blurring so hidden differences do not bleed into
visible samples. Both pixels of a boundary pair must remain visible.
Reports record the PSD hash, contributing layers, sample counts, and ignored
boundary fraction. More than half of the opaque boundary pairs being covered
fails `boundaryVisibility`; empty bands still fail. Historical requests for
other layer snapshots keep the full check without occlusion exclusions.

Extraction still uses only editable pixels. After restoring native dimensions,
`seam` fades the first three pixels inside the mask to one-third, two-thirds,
and full extracted alpha; it never extends artwork outside the mask. This also
applies to soft blush and retains its opacity cap. A passing import cannot
establish whether an expression is natural or hide edits that cut through the
boundary; inspect the composite before using it.

Reports record direct/matched errors and estimated/applied transforms, including
failures. `--read-only` validates recorded request layers and hashes without
changing job files; `--request-dir DIR` with that flag can evaluate archived requests.
With `--read-only --preview-dir .still2rig-psd/review`, accepted results also
write diagnostic input, extracted artwork, and composited crops, plus full-canvas
artwork. The preview directory must be under `.still2rig-psd/` outside this job;
existing outputs and the job manifest remain untouched.
Changed layers require new requests and new generated results.

Inside the editable area, import compares against the underlay. Where both
images have alpha at least 240 it uses the shared-background RGB difference,
so small alpha encoding changes do not turn matching skin into artwork. Other
pixels use premultiplied RGBA, preserving new artwork over transparent underlay.
It keeps pixels whose maximum channel difference exceeds 8 (`--artwork-threshold`),
with a soft alpha ramp over the next 16 levels. Components smaller than 4 native
pixels are discarded (`--minimum-component-pixels`). Requests without an underlay
must be regenerated.

The new artwork is restored onto transparent full-canvas files in
`generated-expressions/`. Import does not approve it: skin-color drift above the
threshold and mismatched edges still require visual review. Use `repair --expressions` for the existing
registration and mouth checks, and visually review both expression states. Only
those checks determine `productionReady`; image generation alone does not.

Closed eyes are registered against each side's alpha union of `eyelash` and
`eyewhite`, falling back to `irides` when that side has no outline. The horizontal
tolerance remains 8 pixels and the vertical plausibility limit remains 32 pixels.

Mouth limits use the face alpha bounding box, so canvas padding does not change
them. Closed mouths allow 16% of face width, 3% of face height and 0.15% of face box
area; open mouths allow 18%, 10% and 1.2%. A filled opening needs more height and
area than a shallow lip line. Floors of 20 pixels width, 12 height and 150 visible
pixels keep small previews usable. Closed-mouth line and bright-fill checks
still apply. The mouth request mask uses the same opening limits plus a boundary
margin and extra space below the lips; its bounds and limits are in `requests.json`.

`repair` records its effective override/expression options and inherits both
the preceding layer overrides and expression source, including preview status.
Explicit directories take precedence; `--no-layer-overrides` and
`--no-expressions` deliberately remove their respective sources.
`inheritedOptions` identifies the reused sources. Legacy records require all
recorded inputs in their conventional directories; unresolved inputs stop
repair. Supplied layer overrides retain tiny components, including highlights
and short nose lines, while still applying the alpha threshold.

## Preview expressions derived from the neutral image

This is a stopgap for when no better expression art is available. Use the
first option that applies:

1. Drawn `eye_close.png` and `mouth_open.png`, passed with `--expressions`.
2. Files made with an image generation tool (for example, Codex image
   generation), registered to the source canvas and passed with
   `--expressions`. They must pass the registration and mouth checks.
3. Derived preview art from `derive-expressions`, described below.

The derived art has a fixed shape: the closed lids are the upper lash line
flipped and flattened, and the open mouth is a small opening drawn under the
closed-mouth line. It cannot show a smiling closed eye or a rounded mouth, and
it may not line up with the iris when the character looks to the side.

`still2rig-psd derive-expressions JOB` draws a preview open mouth and closed
eyes from the finalized layers (the closed lids reuse the upper lash line). Pass
the result with `--preview-expressions DIR` instead of `--expressions DIR`:

```bash
npm run still2rig-psd -- derive-expressions demo
npm run still2rig-psd -- repair demo --preview-expressions .still2rig-psd/jobs/demo/preview-expressions
```

The layers are built into the PSD so blinking and mouth movement can be
previewed, and both reports list them under `previewExpressions`. Because they
are derived rather than drawn, `productionReady` stays `false`. Replace them with
drawn files through `--expressions` to reach the second level.

## Checks performed

The builder follows the complete order in `configs/layer-map.json` and verifies
that the written PSD preserves it. Structural QA verifies required and unique
layers, visible pixels, PSD round-trip integrity, and the critical ordering
relationships listed above. Input, bundle, artifact, and output hashes are
verified by separate workflow stages. Expression QA verifies presence, canvas
registration, compact mouth artwork,
and rejects an overly filled closed mouth or a dominant bright fill. These
numeric checks do not replace visual review of edge color and face-patch seams.

Motion quality requires captured evidence from a renderer. The contract covers
blink and mouth states, continuous lip sync, hair-only movement, full-body idle,
drag inertia, feature stability, and unexpected seam exposure.

## Motion QA with the built-in renderer

```bash
npm run still2rig-psd -- motion-qa demo
npm run still2rig-psd -- motion-qa demo --negative-fixture
```

`motion-qa` opens the job PSD in the preview renderer with headless Chromium,
records every capture in the contract at 1:1 model scale on a solid green
background, and writes frames and `motion-qa.json` under
`.still2rig-psd/jobs/<job>/reports/motion-qa/`. The job manifest records the
result under `result.motionQa`.

When visible `eye_smile` or `blush` artwork is present, the adapter also records
strengths 0, 0.5, and 1. Smiling eyes require every 0.05 step from 0 to 1,
plus 0.48 and 0.52, and half and fully closed blinks at strength 1.
At strengths 0.5, 0.75, and 0.95, pixels in the eye region must still differ
from strength 1 to detect an immediate jump to the final drawing. Both
full-strength blinks must match strength 1. Each expression must change pixels in its own
region while the rest stays stable. These comparisons use an RGB delta greater
than 1 to retain faint blush (the regular eye/mouth checks use 24). Missing
optional artwork adds no capture requirement and does not affect `productionReady`.
The captures still need visual inspection: pixel checks alone do not establish
that every intermediate face looks natural or that the drawing switch is unobtrusive.

In the preview, open **細かい設定** and **目・眉** to adjust **笑い目** and
**頬の赤らみ** from 0 to 1 (default 0). Missing artwork disables its control
and displays a reason. Below strength 0.5, the lower lid rises toward a shallow
smile contour detected separately for each eye at PSD load. The upper lash
retains its ink band, lower-lash fragments are suppressed before they collapse,
and the rising white-eye mask hides the iris from below. Closed-eye artwork is
hidden throughout this transition. At 0.5, only the smiling-eye drawing appears,
matched to the narrowed eye's position and width with a thin, shallow curve.
Its mesh then continuously returns to the original artwork at strength 1.
The crease above the lash keeps its separation; detached outer marks are hidden
while the artwork is displaced. There is no opacity overlap between drawings,
including when closed-eye artwork is absent. Small differences in eyelash tips
or highlights can remain between distinct source drawings; inspect adjacent
captures before accepting an expression set. Blink-driven brow
motion decreases toward the threshold. Smiling eyes follow eye size/position/angle
and head movement without changing the closed-eye anchor. Blush follows the head
and changes opacity only. The same values reach the stream page. Selecting either
part in **重なりを直す** reveals its artwork.

### Expression controls and camera input

The **表情** buttons select a complete face: neutral, joy, shy, angry, sad,
surprised, flustered, unamused or wink. Definitions live in
`configs/expression-presets.json`. Selection updates the expression sliders over
250 ms; the renderer smooths the movement as well. Changing an expression slider
marks the selection **自分で調整中**. Selecting another face replaces expression
values, while pose, gaze, blink, hair and microphone controls retain their values.
Without smiling-eye artwork, joy raises the lower lid using the existing open eye,
and wink closes one eye with a single-drawing handoff to the blink artwork.
The upper lash approaches the closed-eye position and endpoints without thinning.
The closed artwork retains its ink thickness and endpoints as its curve returns. Missing
blush is ignored. Unavailable artwork controls display a reason beside their slider.

Worried and angry brows bend the inner and outer ends in mirrored directions;
the flat-brow control straightens their centerline while retaining ink thickness. The upper-lid control moves the upper
lash down without thinning its ink and clips the iris through the white-eye
stencil. Its signed tilt lowers the inner end for anger or the outer end for
sadness. Widening slightly expands the eye and reduces the iris. These deformations
run before normal blink closure and decrease as the lower lid rises into a smile.
Left and right smile strengths are independent; the shared smile strength takes
the maximum with each side. Mouth form bends both open and closed mouth artwork.

Camera mouth form and brow height are added to the expression values and clamped
to -1..1. Camera pose, gaze and eye openness retain their existing weighted blend;
normal blinking can still close the eyes. Voice and camera mouth openness use the
existing maximum rule. Expression values travel to the stream through the same
validated live settings as the sliders. Older profiles default new controls to zero.

Motion QA records each new part at 0/0.5/1, all nine expressions with open,
half-blinking and closed eyes, and representative transitions. Coverage and the
unchanged opposite eye of a wink have automatic checks. Naturalness still needs
inspection of all 0.05 strength steps, expression endpoints and transition frames
on both a PSD with optional artwork and a PSD without it.

| Check | How it is measured |
| --- | --- |
| Eye and mouth change | Pixels whose largest RGB change exceeds 24 inside the eye or mouth region, open vs. closed. |
| Non-eye stability | Mean absolute RGB error (percent of full scale) outside eyes and brows during a blink. |
| Hair tips | Share of pixels in the lowest quarter of the hair that change during hair-only motion. |
| Fixed features | Mean absolute error of the eye and mouth regions during hair-only motion. |
| Feature layout | Eyes and mouth are tracked in every motion frame. The eye distance and the mouth position predicted from the eyes are compared with the PSD's own registration, so rigid head motion is ignored. |
| Seams | Enclosed holes of the green background inside the neutral silhouette. Background connected to the outside, and background inside visible hair, is treated as expected motion. |

`--negative-fixture` renders a copy whose `mouth_close` is shifted by +24 px
and must FAIL; use it to confirm the checks can still detect a broken layout.

Limits: the checks cover the built-in renderer only. A gap that opens next to
visible hair, and whether the motion looks natural, still need visual review.
Physics frames depend on timing, so borderline results can vary between runs.
Missing required eye layers or feature anchors produce a failed report with a
message instead of crashing the eye-region calculation.

### Transparent tears, sweat and anger artwork

`tears`, `sweat` and `anger_mark` are optional generated overlays. Their requests
use the current face with visible hair as a placement reference; returned PNGs
contain only the added water or red strokes with genuine alpha transparency.
Import checks proportions, request hashes, transparent background, visible alpha
outside the allowed region, sparse coverage, neutral background patches and warm
skin/hair-like colors. These color checks are heuristics: inspect the isolated
layer over a checkerboard and its composite before repair. Unlike edited face
crops, transparent artwork has no unchanged background from which to estimate
alignment or a seam. Placement is checked in the registered canvas coordinates.

Tears sit in front of the eyes but behind front hair, appear from the lower-lid
edge downwards, and keep their upper edge attached during blinking. Sweat moves
down a few pixels as it appears; the anger symbol grows slightly into place.
Both sit above the hair and follow head motion. Sadness uses tears, flustered uses
sweat, and anger uses the symbol. Missing artwork keeps the previous face and
disables the corresponding slider with a reason. No overlay changes production
readiness. Review strengths every 0.05, blink states, head turns and transitions;
a successful pixel check does not establish natural-looking artwork or motion.

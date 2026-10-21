---
name: still2rig-psd
description: Convert a user-provided static anime character image into a verified rig-ready PSD by coordinating the Still2Rig PSD local job CLI with a user-approved Google Colab session through Colab MCP Go. Use for Still2Rig PSD conversion, repair, import, or QA requests; do not use for unrelated PSD editing or general browser automation.
---

# Still2Rig PSD

Use the project CLI as the source of truth for job state and generated Colab
cells. Run commands from the repository root.

## Preflight and job creation

1. Run `npm run doctor`. Resolve missing local prerequisites without modifying
   global Codex configuration. Installing software still requires normal user
   approval.
2. Run `npm run still2rig-psd -- prepare <image> [--name <job>]`.
3. Confirm the copied input hash in `.still2rig-psd/jobs/<job>/job.json` before any
   remote execution.

## Colab consent boundary

Before connecting, tell the user that the next MCP call will wait for their
Colab tab. Run `npm run still2rig-psd -- colab-url` and give that URL to the user so
they can open it in the intended signed-in Chrome profile and select an L4 GPU.

- Use only the `colab-mcp` tools supplied by Colab MCP Go.
- Do not use Chrome control, an in-app browser, Computer Use, or UI automation.
- Do not select an account, accept terms, allocate a runtime, or change a GPU on
  the user's behalf.
- Call `open_colab_browser_connection` only after clearly announcing it. The
  MCP approval prompt is the authorization gate.
- Never call `disconnect_colab_runtime` or delete the runtime. Leave release of
  compute to the user unless they explicitly request it in the current turn.
- Stop after three connection failures and report the exact failure; do not
  switch to another browser or MCP implementation silently.

## Execute the generated cells

After connection, call `list_colab_tools`. Use the notebook tools it reports
(normally `add_code_cell`, `run_code_cell`, and `get_cells`; names can vary).
Add and run these exact generated files in order:

1. `01-upload.py`
2. `02-setup.py`
3. `03-run.py`
4. `04-download.py`

Read a cell with `npm run still2rig-psd -- cell <job> <cell-file>`. Do not rewrite
the cell ad hoc. Wait for completion and inspect outputs after each stage. Stop
on Python exceptions, input-hash mismatch, wrong GPU, revision mismatch, or a
missing output PSD. The final cell starts a normal browser download; it does not
transfer bytes through the MCP response.

## Import and finalize

Once `still2rig-psd-<job>.zip` is present locally, run:

```bash
npm run still2rig-psd -- import <job> /path/to/still2rig-psd-<job>.zip
npm run still2rig-psd -- finalize <job>
```

If the user provides full-canvas, registered expression files named
`mouth_open.png`, `mouth_close.png`, or `eye_close.png`, pass their directory as
`--expressions <dir>`. Use `--preview-placeholders` only when the user wants a
non-production preview. Never describe copied or missing expressions as real
lip-sync or blink art.

Choose the expression source in this order:

1. Drawn expression files from the user: pass them with `--expressions <dir>`.
2. An available image generation tool (for example, Codex image generation):
   use the masked request and import flow below, pass the resulting full-canvas
   files with `--expressions <dir>`, and report them as generated art. Require
   `expressionRegistration=true` and `expressionArtwork=true`, plus visual
   review, before calling them checked.
3. Only when neither is available, as a stopgap: run
   `npm run still2rig-psd -- derive-expressions <job>` and rebuild with
   `repair <job> --preview-expressions <dir>`. The derived layers reuse the
   upper lash line and draw a small fixed-shape mouth, so they are less accurate
   than generated or drawn art. The reports list them under
   `previewExpressions` and keep `productionReady=false`.

For mouth repair, prefer extracting the closed-mouth ink from the registered
original artwork. Do not fill the component interior or carry a skin-colored
rectangle into an expression layer. A derived opposite mouth state is preview
art, not trustworthy production art. Render both mouth states at full-canvas
scale and as a face crop, then require `expressionArtwork=true` and
`mouthWithinTolerance=true` in the QA report before reporting the repair.

## Image-generated expressions

Prepare local requests with:

```bash
npm run still2rig-psd -- expression-requests <job>
```

This creates `.still2rig-psd/jobs/<job>/expression-requests/` with `input.png`,
`mask.png` and `prompt.txt` for `eye_close` and `mouth_open`. The inputs are face
crops of the current PSD layers, including the latest repair. Do not substitute
`input/source.png`: See-through may resize or pad it to a different canvas.
Small crops are enlarged toward a 1024-pixel long side, capped at 4x. Keep the
requested size; `requests.json` records the scale used to restore native pixels.
Front hair and head accessories above the expressions are intentionally hidden;
tell the generator not to add them. Each variant's `underlay.png` is the face
without the source eyes or mouth; keep it local and unchanged for extraction.
Transparent mask pixels may change; opaque mask pixels must remain identical.

Before generation, get the user's approval. The images leave the machine when
sent to the generator. A request copied from the preview with **Codex** selected
says the user already agreed to Codex's built-in image generation; that counts
as approval for Codex imagegen only, not for other services. Otherwise, explain
which face crops and service will be used, then ask and wait. Preparing local
request files alone does not require this consent.

If image generation is available (for example, Codex imagegen), inspect each
input and mask, then generate each variant using its `input.png`, `mask.png` and
the exact instructions in `prompt.txt`. Save the returned PNGs as
`expression-requests/results/eye_close.png` and `mouth_open.png`. If the agent
cannot generate images (for example, Claude Code), stop at this stage and tell
the user which three files for each variant to hand to a generator, where to
save the results, and how to resume. Do not substitute derived preview art.

After results are available:

```bash
npm run still2rig-psd -- import-expressions <job>
npm run still2rig-psd -- repair <job> --expressions .still2rig-psd/jobs/<job>/generated-expressions
```

Repair automatically inherits the preceding layer overrides and expression
source, including preview status, and reports them in `inheritedOptions`. Verify
that corrected layers and expressions remain present. Explicit source flags win;
`--no-layer-overrides` and `--no-expressions` deliberately remove their sources.
Legacy repairs require every recorded file in its conventional directory. If
inputs cannot be resolved, restore them or ask whether to remove them. Supplied
layer overrides retain tiny highlights/ink while still applying the alpha
threshold. Each repair records its effective options.
Layer cleanup hides the inferred neck where the source shows the collar or
clothing in front of it, and reports it as `neckTuck` in
`layer-inspection.json`. Do not draw a neck override only to tuck the neck into
a collar; check `neckTuck` first.

Import validates proportions and current layer hashes. Alignment uses an
8-native-pixel band with input alpha >=240 and subpixel refinement. Meaningful
drift may be compensated only within a 12-pixel displacement magnitude and 3%
uniform scale error; the original result is sampled once. Read the applied
transform as well as the estimate. Shared-white-background RGB comparison avoids
false differences from near-opaque alpha encoding. Symmetric 2-pixel color
matching in `strict` mode keeps the mean/p99 limits at 6/20; direct errors remain in the report.
Face-interior 4x4 tiles add local/flat limits of 24/12 to catch missing ink or
painted patches. Outer hair contours use the global band check. Two character
samples passed; synthetic removed/moved brows, patches and excessive drift must
fail. See `docs/quality-gates.md` for metric boundaries and calibration.
`--read-only` evaluates recorded provenance without changing files; use
`--request-dir DIR` with it to inspect archived requests.

Expression definitions select `protectedCheck`: `eye_close` and `mouth_open`
use `strict`, while `eye_smile` and `blush` use `seam`. Use
`import-expressions JOB [DIR] --protected-check strict|seam` for a temporary
override. Alignment and provenance remain mandatory. In `seam`, whole-outside
mean/p99 limits are 18/80. Both 3-native-pixel boundary bands use radius-1 blurred
RGB residuals against the original outside and the PSD underlay inside (source
eye/mouth removal is intentional), with mean/p95 limits 6/20. Inner 4x4 tile means have limit 12; outer tile
means and worst locations are diagnostic only because extraction keeps original
artwork outside the mask. `diagnostics.outerTiles` reports its limit comparison
without gating import. Adjacent
inside/outside residual jumps have p95 limit 12. Only opaque reference pixels
are sampled; missing band support fails. Reports identify failed bands and tiles.
Permanent layers in front of the expression can exclude fully covered pixels
from seam metrics. Coverage uses finalized PSD order, offsets, layer opacity 1,
and alpha exactly 255; absent expressions use layer-map insertion order. Hidden,
translucent, masked, clipped, non-normal and animated expression layers do not
establish coverage. Covered residuals are zeroed before blurring. Reports include
the PSD hash, contributors and ignored boundary-pair fraction; more than half
covered or empty sample support fails. Historical layer snapshots retain the
full check without borrowing the current PSD coverage.

Smiling-eye requests preserve the source white/lash alpha union, including faint
tips, with at least 4 native pixels of lateral margin (or the larger dilation).
This eye envelope takes precedence over front-hair protection; eyebrow protection
remains. Cheek edits stop 4 native pixels inside the face contour.

After restoration, the first three inside pixels fade from one-third to full
extracted alpha, including soft blush; no outside pixels are imported.

Use `--read-only` to evaluate archived results without changing job files.
Optional `--preview-dir .still2rig-psd/review` writes accepted input/art/composite
crops and full-canvas artwork outside the source job. Inspect these crops before
repair. Do not relax limits solely to force an import pass. No import pass
establishes natural expression art or motion quality.

Import removes matching skin using the same RGB comparison where both result
and underlay are nearly opaque, and premultiplied RGBA elsewhere. It removes
tiny components at native scale and restores artwork with soft alpha edges. Read
`generated-expressions/report.json`, including measured protected-pixel errors.
If layers changed, regenerate the requests and results. If protected pixels
changed too much, request a corrected image rather than increasing tolerances
just to obtain a pass. Requests without the underlay must be regenerated. Color
drift above the extraction threshold may still leave skin; existing mouth QA
must still reject unsuitable patches. Inspect face crops and
both full-canvas expression states for color, alignment and edge seams after
repair. Import does not set `productionReady`; existing QA remains authoritative.
Closed-eye registration uses the per-side eyelash/eyewhite alpha union, with iris
fallback and the same 8-pixel horizontal tolerance. Mouth limits and the mouth
request mask share face-bbox-relative settings, with separate closed/open limits.

## Motion QA

Run `npm run still2rig-psd -- motion-qa <job>` after the PSD is final. It records
the contract captures in the built-in preview renderer and scores them. Run it
again with `--negative-fixture` when the checks themselves changed; that run must
FAIL. Only a passing `motion-qa` report for the current PSD SHA-256 supports a
motion, seam, or hair-motion claim, and only for the built-in renderer.

If the PSD includes visible `eye_smile` or `blush` artwork, motion QA also
captures strengths 0, 0.5, and 1 and checks changes inside the expression region
and stability outside it. Smiling eyes capture every 0.05 step from 0 to 1 plus
0.48 and 0.52. Strengths 0.5, 0.75 and 0.95 must still differ from strength 1,
so an immediate jump to the final drawing fails. Half and fully closed blinks at strength 1
must stay identical. These optional checks
use an RGB delta greater than 1 for faint blush; the regular eye/mouth threshold
remains 24. Missing optional artwork adds no capture requirement and does not
change expression production readiness. Inspect the full strength strip and
adjacent switch frames: automated pixel checks cannot establish natural-looking
intermediate faces or an unobtrusive drawing switch.

The preview and stream page support both strengths (0..1, default 0). In
**細かい設定 → 目・眉**, **笑い目** and **頬の赤らみ** are disabled with a reason
when the PSD has no matching artwork. Below strength 0.5, the lower lid rises
toward a shallow smile contour detected at PSD load. The upper lash retains
its ink band; lower-lash fragments are suppressed before they collapse, and the
white-eye stencil hides the iris from below. Closed-eye artwork stays hidden.
At 0.5 only the smile drawing appears, initially matched to the narrowed eye's
position and width with a thin, shallow curve. Its mesh continuously restores
the original artwork at strength 1. The upper crease keeps its separation;
detached outer marks are hidden while displaced. Drawings never overlap in
opacity, including without closed-eye artwork. Inspect adjacent captures for
remaining differences in lash tips or highlights before accepting the artwork.
Blink-driven brow motion decreases toward the threshold. Smiling eyes follow eye/head controls;
blush follows the head with opacity only. Selecting either part in
**重なりを直す** reveals it.

### Expression combinations

`configs/expression-presets.json` defines the nine faces in the **表情** buttons.
Selection updates only expression sliders over 250 ms; manual changes show
**自分で調整中**. Pose, gaze, normal blinking and voice input stay independent.
Without smile artwork, joy raises the lower lid of the existing eye and wink
closes one eye, handing off to closed-eye art without overlapping drawings.
Missing blush is ignored. Brow deformation preserves ink thickness while
changing its centerline. New controls bend worried/angry/flat brows,
lower and tilt the upper lid, widen eyes and adjust smiling eyes per side.
Mouth form affects both closed and open artwork. Camera mouth form and brow
height add to expression values (clamped to -1..1); other tracking values keep
their existing weighted blend. Upper-lid and widening deformations precede blink
closure and diminish into a smile, so normal blinks still close fully.
All values reach the stream in validated live settings; old profiles use zero
for new controls. Motion QA captures parts, preset blink states and representative
transitions. It checks coverage and wink-side isolation, not visual naturalness.
Inspect every 0.05 strength step, endpoints and representative transitions on
PSDs both with and without optional artwork, and retain close-up evidence.

## Completion report

Report the job id, input SHA-256, pinned See-through revision, PSD path and
SHA-256, contact sheet, structural QA result, expression readiness (including
any `previewExpressions`), and the `motion-qa` result or that it was not run. A structurally valid PSD is not automatically a
Live2D- or renderer-ready rig.

Tell the user that `npm run preview` starts the built-in local PSD preview. It
lists finalized outputs and opens the newest PSD without exposing internal job
details in the UI. Do not launch a browser automatically.

For failure modes and the exact trust model, read
`../../../docs/codex-workflow.md` and `../../../docs/security.md` only when they
are relevant.

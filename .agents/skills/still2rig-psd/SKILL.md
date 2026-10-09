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
Front hair and head accessories above the expressions are intentionally hidden;
tell the generator not to add them. Each variant's `underlay.png` is the face
without the source eyes or mouth; keep it local and unchanged for extraction.
Transparent mask pixels may change; opaque mask pixels must remain identical.

Before generation, explain which face crops and service will be used, then ask
the user for approval and wait. The images leave the machine when sent to the
generator. Preparing local request files alone does not require this consent.

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

Import validates proportions, changes outside the mask and current layer hashes,
then compares the editable area against the underlay, removes matching skin and
tiny noise components, and restores only the new artwork to full-canvas
transparent files with soft alpha edges. Read
`generated-expressions/report.json`, including measured protected-pixel errors.
If layers changed, regenerate the requests and results. If protected pixels
changed too much, request a corrected image rather than increasing tolerances
just to obtain a pass. Requests without the underlay must be regenerated. Color
drift above the extraction threshold may still leave skin; existing mouth QA
must still reject unsuitable patches. Inspect face crops and
both full-canvas expression states for color, alignment and edge seams after
repair. Import does not set `productionReady`; existing QA remains authoritative.

## Motion QA

Run `npm run still2rig-psd -- motion-qa <job>` after the PSD is final. It records
the contract captures in the built-in preview renderer and scores them. Run it
again with `--negative-fixture` when the checks themselves changed; that run must
FAIL. Only a passing `motion-qa` report for the current PSD SHA-256 supports a
motion, seam, or hair-motion claim, and only for the built-in renderer.

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

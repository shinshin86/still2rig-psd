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
   generate full-canvas `eye_close.png` and `mouth_open.png` registered to the
   source, pass them with `--expressions <dir>`, and report them as generated
   art. Require `expressionRegistration=true` and `expressionArtwork=true`
   before calling them ready.
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

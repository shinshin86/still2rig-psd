# Still2Rig PSD

Turn one static anime character image into a structured, QA-checked PSD with
Codex, a user-approved Google Colab GPU session, and a built-in motion preview.

[日本語版](README.ja.md)

![Still2Rig PSD WebUI showing a layered character and motion controls](docs/assets/still2rig-psd-webui-preview.webp)

Load a generated PSD in the built-in WebUI to check eye and mouth states,
automatic blinking, hair and full-body motion, positioning, and zoom.

Still2Rig PSD is designed to be used from Codex. Attach an image, ask Codex to
convert it, and Codex prepares the run, controls the approved Colab notebook,
verifies the returned files, assembles the PSD, and reports the result. You
remain in control of Google sign-in, the Chrome profile, GPU selection, and
Colab connection approval.
To use another agent such as Claude Code, or a local See-through, see
"Using another agent or a local See-through" below.

> **Status: v0.1 alpha.** A single neutral image cannot reliably provide real
> closed-eye and alternate-mouth artwork. Still2Rig PSD reports missing
> expression art instead of presenting a placeholder as production-ready.

## What it uses

- [See-through](https://github.com/shitagaki-lab/see-through) for semantic
  single-image layer decomposition
- [Colab MCP Go](https://github.com/shinshin86/colab-mcp-go) for local,
  approval-gated control of a Google Colab notebook
- Local tools for hash verification, layer cleanup, deterministic PSD assembly,
  and structural QA
- A built-in WebUI for blink, mouth, body, hair, drag, and zoom previews, plus
  plain-language front/back overlap repair, before/after comparison, progress
  feedback for slower PSD rebuilds, and safe export

## Using another agent or a local See-through

The steps in this README are written for Codex with Google Colab, but you can
swap either one for something else.

- **Agents other than Codex (Claude Code, for example):** the workflow is
  written in `.agents/skills/still2rig-psd/SKILL.md` and `AGENTS.md`. Ask your
  agent to read both files and convert your image to a PSD. To use Colab,
  register `scripts/start-colab-mcp.sh` as an MCP server with the same settings
  as `.codex/config.toml`. How you register it depends on the agent.
- **Local See-through:** to run See-through on your own GPU instead of Colab,
  tell the agent not to use Colab and to separate the layers with your local
  See-through. This repository does not ship commands for a local run, so you
  set up and run See-through together with your agent. Once the separated
  layers are imported in this project's format, PSD assembly, QA, and the WebUI
  preview work the same way as with Colab.

## Quick start

### 1. Install the requirements

- Codex CLI, IDE extension, or desktop app
- Node.js 20.19 or newer
- Python 3.9 or newer with Pillow
- Go 1.25 or newer
- A Google Colab account with an L4 runtime available

From the project root:

```bash
npm install
python3 -m pip install -r requirements-local.txt
go install github.com/shinshin86/colab-mcp-go/cmd/colab-mcp-go@v0.0.0-20260824110853-5c9e997958bf
npm run doctor
```

Make sure `$(go env GOPATH)/bin` is on `PATH` before starting Codex.
The install command pins the Colab MCP Go revision tested by this project.

### 2. Start Codex in this project

Open the project root in Codex and trust the repository-scoped
`.codex/config.toml`. Restart Codex once if the Colab MCP tools do not appear in
the current session. The project does not require changes to your global Codex
configuration. Its bridge selects an available localhost port automatically,
so it can coexist with a Colab MCP process started by another Codex project.

Colab MCP Go itself is not bundled in this repository. The project configuration
starts the separately installed `colab-mcp-go` command when needed. It does not
discover or attach to an already-running global process; it starts a dedicated
process on an available port. Other Colab MCP processes can remain running. A
Codex restart is needed only when loading a changed MCP configuration into the
current session, not for every PSD conversion.

### 3. Attach an image and ask Codex

Attach a PNG, JPEG, or WebP anime character image, or provide its local path,
then use a request such as:

```text
Use $still2rig-psd to convert this static anime character image into a verified
layered PSD through my approved Google Colab session. Continue through import,
PSD assembly, and QA, then tell me how to open the preview.
```

Codex then:

1. Copies the image into the Git-ignored work area and records its SHA-256 hash.
2. Generates the exact upload, setup, inference, and download cells.
3. Shows a tokenized Colab URL and waits for your connection approval.
4. Runs a pinned See-through revision on the approved L4 runtime.
5. Verifies the downloaded bundle, cleans the layers, assembles the PSD, and
   runs structural QA.
6. Reports the PSD path, QA result, and any expression or motion work still
   required.

When Colab downloads the result ZIP in your browser, Codex may ask for its local
path if it cannot locate the download automatically.

The Colab URL contains a connection token. Do not publish it, share it, or
include it in screenshots.

### 4. Preview the PSD

Start the built-in local preview:

```bash
npm run preview
```

Open the printed local URL. The WebUI lists generated PSDs from
`.still2rig-psd/jobs/*/output/`, selects the newest result, and also accepts a
local PSD through file selection or drag-and-drop. For a generated PSD,
**Open save location** opens its output folder in the operating system's file manager.
The **Fix overlaps** mode supports alpha-aware canvas selection, offers candidates
when multiple parts overlap, moves parts forward or backward, compares the edit
with the source, supports detailed mouse-based drag sorting on desktop, and
downloads a verified copy without overwriting the original PSD. Touch-based layer
sorting on phones is not supported.

## Automation and consent boundaries

| Codex handles | You control |
| --- | --- |
| Preparing the local run and generated notebook cells | Choosing the Chrome profile and Google account |
| Running See-through after connection approval | Opening the Colab URL and selecting an L4 runtime |
| Verifying the returned archive and hashes | Approving the Colab MCP connection |
| Cleaning layers, assembling the PSD, and running QA | Deciding when to disconnect or delete the runtime |
| Reporting the output and preview command | Providing real expression artwork when the source image does not contain it |

Still2Rig PSD does not automate Chrome, sign in to Google, select an account,
allocate a runtime, edit global Codex settings, or disconnect a Colab runtime.

## Output structure

Every run is stored under the Git-ignored `.still2rig-psd/jobs/<name>/`
directory:

```text
.still2rig-psd/jobs/<name>/
  input/                 copied source image
  colab/                 generated notebook cells
  raw/imported/          verified See-through result
  processed/layers/      cleaned full-canvas layers
  output/<name>.psd      assembled PSD
  reports/               contact sheet and QA reports
  job.json               hashes, settings, and provenance
```

Input art, generated PSDs, Colab tokens, logs, screenshots, videos, model
weights, and downloaded archives are ignored by Git by default.

## Quality checks and limitations

The CLI reports the first two cumulative levels below after `finalize` or
`repair`. The third level comes from `motion-qa`, which records the built-in
preview renderer against `configs/motion-qa-contract.json`.

| Level | Meaning |
| --- | --- |
| **Structure checked** | The PSD was written in the configured order and structural QA passed its required layers and critical front/back relationships. Hashes are verified separately by the workflow. |
| **Mouth/closed-eye files checked** | `mouth_open` and `eye_close` are present, are not built-in placeholders, and passed registration and numeric mouth checks. Visual review is still required. |
| **Motion checked by an adapter** | `motion-qa` recorded the built-in preview renderer and every declared motion check passed. Other renderers are not covered. |

The default back-to-front order is `back hair` → lower-body clothing → arms →
upper-body clothing → neck → ears → face → eyes, brows, nose, and mouth →
`front hair` → headwear. Keeping
side-positioned arms behind clothing prevents shoulder edges from crossing the
shirt. A hand crossing in front of the shirt needs separate back and front
artwork; one arm layer cannot represent both depths.

If the source does not show an open mouth or closed eyes, those states cannot be
determined reliably. `--preview-placeholders` is only for exercising the
controls and is not treated as real expression art. `derive-expressions` draws
a preview open mouth and closed eyes from the neutral layers; passed with
`--preview-expressions`, they appear in the preview but keep
`productionReady=false`.

See [Understanding the generated PSD](docs/quality-gates.md) for the exact layer
contract, required expression files, and what each reported level proves.
Still2Rig PSD does not claim one-click Live2D production readiness.

## Direct CLI

The repository skill normally runs these commands for you. They are also
available for debugging or manual operation:

```bash
npm run still2rig-psd -- prepare ./character.png --name demo
npm run still2rig-psd -- colab-url
npm run still2rig-psd -- status demo
npm run still2rig-psd -- import demo /path/to/still2rig-psd-demo.zip
npm run still2rig-psd -- finalize demo --expressions /path/to/expression-layers
npm run still2rig-psd -- repair demo --expressions /path/to/repaired-expression-layers
npm run still2rig-psd -- derive-expressions demo
npm run still2rig-psd -- repair demo --preview-expressions .still2rig-psd/jobs/demo/preview-expressions
npm run still2rig-psd -- motion-qa demo
```

`repair` reuses the verified imported result without rerunning Colab. It backs
up the current PSD and reports under the ignored job directory, rebuilds in an
isolated repair directory, runs structural QA, and replaces the previewed PSD
only after the repaired build succeeds.

## Security and privacy

- The Colab MCP bridge listens on localhost and requires a random connection
  token.
- The source image and generated cells are sent to the user-approved Colab
  runtime for processing. The runtime remains assigned until the user releases
  it.
- The built-in preview listens on `127.0.0.1` and serves only known generated
  PSD files from the ignored output directories.
- Imported ZIP files are treated as untrusted and checked for traversal,
  symbolic links, size limits, and hash mismatches.
- Do not publish source art or generated assets unless you have the necessary
  rights.

See [Security, privacy, and consent](docs/security.md) for the full trust model.

## Licensing

Still2Rig PSD is MIT licensed. See-through and Colab MCP Go are separate
Apache-2.0 projects. The preview redistributes the MIT-licensed Anime2.5DRig
`rigger.js` runtime with its license text. Model weights downloaded by upstream
tools may have additional terms.

See [NOTICE.md](NOTICE.md) for third-party notices.

## Documentation

- [Codex and Colab workflow](docs/codex-workflow.md)
- [Architecture and provenance](docs/architecture.md)
- [Understanding the generated PSD](docs/quality-gates.md)
- [Security, privacy, and consent](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Built-in PSD preview](webui/README.md)

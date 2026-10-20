# Security, privacy, and consent

## Local data

`.still2rig-psd/` is ignored and contains every source image, generated cell, token,
download, PSD, report, screenshot, and video. Do not move these artifacts into
tracked folders unless the rights holder explicitly intends to publish them.

The importer treats a Colab ZIP as untrusted input. It rejects absolute paths,
parent traversal, symbolic links, excessive file counts, excessive expanded
size, missing manifests, and mismatched hashes.

The built-in PSD preview binds to `127.0.0.1`. Its local API lists no absolute
paths and serves only regular `.psd` files discovered beneath ignored job
output directories. It does not follow output-directory symlinks or expose
arbitrary filesystem paths. PSDs selected with the file picker or drag-and-drop
remain in the browser.

## Optional camera preview

Camera frames are processed only inside the browser, in a dedicated worker.
They are neither saved nor transmitted. Audio is not requested. Stopping the
camera or leaving the page stops all camera tracks and terminates the worker.
Only pose angles and expression scores return to the page from the worker.

The first preparation, explicitly requested through the preview button or
`npm run still2rig-psd -- face-model`, downloads one model from the fixed URL
https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task.
The server checks its size (3,758,596 bytes) and SHA-256
`64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`
before atomically installing it under `.still2rig-psd/models/mediapipe/`.
`STILL2RIG_PSD_MODELS_ROOT` can override the local model root. An existing model
must pass the same checks. Verification results are cached while file size,
modification time, and identity metadata remain unchanged; installing a downloaded
model invalidates the cache. The download endpoint shares origin validation with
the folder-opening endpoint,
but requires its own `X-Still2Rig-Action: prepare-face-model` header. The
folder-opening endpoint accepts only `open-generated-folder`. Only the fixed
model file and
allowlisted installed JavaScript/WASM files can be served. Both Vite development
and preview servers serve these assets locally; static hosting alone is not
supported for camera tracking. Tracking requires no external requests once the
model is prepared.

`@mediapipe/tasks-vision` is pinned exactly to 0.10.21 because newer releases
(including 1.0.1) introduce external metrics reporting. Review telemetry and
asset loading before any upgrade, and rerun network-isolation QA. No CDN is used.

## Local stream view

The stream page reads only a generated PSD selected through its opaque identifier.
Its URL never contains an absolute path. The identifier is deterministic from the
output location, so it survives a server restart while that location is unchanged.
Files opened through the local file picker are unavailable to the stream page.

`POST /api/live/state` accepts at most 16 KiB of JSON, requires the same origin
and the dedicated `X-Still2Rig-Action: live-state` header, and validates known
fields, types and finite numbers. Numeric ranges are clamped. Images, audio,
video and landmark arrays are rejected. Only pose numbers, motion settings,
opaque PSD IDs and an ephemeral source ID pass through this PC's local server.
The receiver uses `GET /api/live/events`; neither path relies on development HMR.
Cross-origin event connections are rejected. No CORS access is enabled.

Only the latest state is retained in memory. Slow receivers have one replaceable
pending update, and source pages have at most one outgoing request. Updates are
limited to approximately 30 per second. A 1.5-second source lease prevents
multiple tabs from alternating the same character's pose. Stale, unobserved
channels are removed, and all state disappears when the server stops. The server
continues to bind to `127.0.0.1`; do not expose it to a network. No stream state
or camera frames are written to disk.

## Colab connection

The MCP bridge binds to an automatically selected localhost port. The selected
port and a random token are persisted only so the project can print a URL that
the user opens in the desired Chrome profile. The wrapper uses `--no-browser`;
Still2Rig PSD never launches or controls Chrome.

The printed Colab URL contains that connection token. Treat the URL as a secret:
do not publish it, share it, or include it in screenshots. The source image and
generated notebook cells are sent to the user-approved Colab runtime for
processing; they are not confined to the local ignored directory.

The user controls Google sign-in, account choice, terms, runtime accelerator,
and runtime deletion. An approved MCP connection authorizes only the requested
notebook workflow. Still2Rig PSD leaves the runtime running after completion,
so the user must release it when it is no longer needed.

## External code and weights

The worker checks out an exact See-through commit and records it. Python and
model dependencies still come from third-party package and model registries;
users should review upstream licenses, model cards, and supply-chain risk before
commercial or sensitive use.

## Before public release

Run a full secret and privacy scan, inspect notebook/cell outputs, binary assets,
Git history, ignore rules, dependency manifests, and documentation. Do not place
the audit report inside the repository being audited.

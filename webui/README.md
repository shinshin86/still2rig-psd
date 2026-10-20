# Still2Rig PSD built-in preview

This local WebUI is the standard preview surface for PSD files produced by
Still2Rig PSD. It is a first-class project feature rather than a bundled
character demo.

On startup, the local server lists finalized files under the ignored
`.still2rig-psd/jobs/*/output/*.psd` directories and automatically opens the
newest result. The selector can switch between earlier results or refresh the
list while the server remains open.

## Run from the repository root

```bash
npm run preview
```

Open the printed local URL. A production build and automated browser QA are
also available:

```bash
npm run preview:build
npm run preview:qa
```

Node.js 20.19 or newer is required by the WebUI toolchain.

The preview is designed for desktop browsers and listens on `127.0.0.1` by
default. Its narrow layout remains readable and keeps PSD selection before the
canvas, but phone access, touch-based layer sorting, and large-PSD memory use
are not supported. Do not expose the generated-PSD API to a LAN without
reviewing the privacy implications.

## PSD sources

- Generated PSDs: served only from `.still2rig-psd/jobs/*/output/`
- Local file picker: read in the browser with `File.arrayBuffer()`
- Drag-and-drop: read in the browser without uploading the file

The local server returns a generated-file list without absolute paths and maps
opaque IDs back to known PSD files. It does not provide arbitrary filesystem
browsing. Symlinks in output directories are not served.

## Controls

- Generated-PSD selector and list refresh
- Open the selected generated PSD's folder in Finder, File Explorer, or the Linux file manager
- Eye and mouth open/close sliders
- Automatic blinking toggle, independent of the selected motion mode
- Static, hair-motion, and full-body-plus-hair motion modes
- One-click automatic motion check near the top of the controls
- Calm, standard, and active motion presets
- Detailed intensity, idle, breathing, wind, hair amplitude, softness, and
  drag-inertia multipliers
- Expandable advanced parameters for 32 internal baseline values, grouped into
  pose/body, eyes/brows, mouth, and hair/physics controls; each value has a
  slider, exact numeric input, displayed default, and one-click reset
- Canvas drag, wheel zoom, zoom slider, and view reset
- PSD drag-and-drop and file-picker input
- Separate **Check motion**, **Fix overlaps**, and **Camera motion** tabs
- Plain-language front/back fixes for arms, clothing, face, and front hair
- Alpha-aware canvas click selection with overlap candidates and visible selection feedback
- One-step front/back movement, desktop drag sorting with a visible insertion target,
  undo, reset, and original/edited comparison
- Preview-local progress feedback for slower PSD rebuild, comparison, and export work
- Safe export to a new `*-重なり修正版.psd` file; the source PSD is never overwritten
- Export round-trip validation before the browser download starts

Motion settings remain active when another PSD is loaded in the same page.
Reloading the page restores the standard preset.

## Expected PSD structure

The renderer follows Anime2.5DRig layer naming, including `face`, `back hair`,
`front hair`, `eyewhite`, `irides`, `eye_close`, `mouth_open`, and
`mouth_close`. A missing `face` layer is a blocking error. Missing optional
parts reduce available animation states.

This preview does not replace Still2Rig PSD structural QA. Publication-quality
motion claims still require the capture contract in
`../configs/motion-qa-contract.json`. `scripts/run-motion-qa.mjs` is the
capture adapter for that contract; run it through
`npm run still2rig-psd -- motion-qa JOB` from the repository root.

## Privacy and licensing

No character artwork or sample PSD is included. Browser QA generates synthetic
geometry at runtime and stores all fixtures and captures under the ignored
`.still2rig-psd/webui-qa/` directory.

The automatic rigger and WebGL motion implementation are based on
[Anime2.5DRig](https://github.com/852wa/Anime2.5DRig), Copyright (c) 2026
hakoniwa, MIT License. See `third-party/Anime2.5DRig-LICENSE.txt` and the root
`NOTICE.md`.

---

## 日本語

このWebUIは、Still2Rig PSDで生成したPSDをすぐに確認するための正式なローカル
プレビュー機能です。キャラクターを同梱するデモではありません。

リポジトリ直下で次を実行します。

```bash
npm run preview
```

起動するとGit管理外の`.still2rig-psd/jobs/*/output/*.psd`を検索し、最新のPSDを
自動表示します。セレクトボックスで過去の生成結果へ切り替えられ、サーバーを
起動したまま一覧を更新できます。手元PSDの選択とドラッグ＆ドロップにも対応します。
生成済みPSDを選ぶと、「保存先を開く」からFinder、エクスプローラー、またはLinuxの
ファイルマネージャーで保存フォルダを開けます。手元から読み込んだPSDは、ブラウザが
元の保存場所を開示しないため対象外です。
初期表示はアバターの周囲に余白を取った90%倍率です。自動まばたきは、静止・髪揺れ・
全身＋髪の各モーションとは独立してON/OFFできます。

「動きの強さを細かく調整」では、7項目の強さを変更できます。さらに「細かい設定」を
開くと、顔や体の向き、目・眉、口、髪・物理の計32項目を、スライダーと数値入力で
調整できます。各項目には最初の値を表示し、「最初の値に戻す」でまとめて元に戻せます。

「重なりを直す」では、人物上の直したい部分をクリックして選べます。
複数の部分が重なる場所では候補を表示します。PSDの専門用語を使わず「腕・手を服の手前／奥へ」
「前髪を顔の手前／奥へ」のように前後関係を変更できます。変更前との比較、1つ戻す、
今回の変更の取り消し、PCのマウスによる細かいドラッグ並べ替えにも対応します。保存時は元のPSDを上書きせず、
`-重なり修正版.psd`という別ファイルを作成し、再読込で並びを確認してからダウンロードします。
PSDの組み直し、変更前との切り替え、保存準備に時間がかかる場合は、プレビュー上に現在の
処理内容を表示します。短時間で終わる操作では表示を遅らせ、画面がちらつかないようにしています。

このプレビューはデスクトップブラウザ向けで、既定では`127.0.0.1`だけで待ち受けます。
狭い画面でも読み込み導線は表示されますが、スマートフォンからの接続、タッチ操作での
レイヤー並べ替え、大容量PSDのメモリ使用量は対応対象外です。

PSD、合成QA素材、スクリーンショットはすべてGit管理外に保存されます。

## Camera motion

Load a PSD, then open the **カメラで動かす** tab. On first use, press the preparation
button to download the approximately 4 MB face model, or prepare it from the
repository root with `npm run still2rig-psd -- face-model`. Nothing downloads
automatically. The CLI and preview share the same hash-verified local model.

Load a PSD, start the camera, face forward, and register your neutral face.
Mirror motion is enabled by default. Adjust motion size and smoothing as needed;
the optional camera image starts hidden. Controls for face and body direction, gaze, eye and mouth opening, mouth shape,
and brow height, along with the automatic demo, are disabled while the camera
controls the character. Hair, body shape, and eye/mouth position and size remain
adjustable in the **動きを確認** tab without stopping the camera. A small dot
on the camera tab indicates that it is running. Stop the camera to restore the
existing settings. Switching to **重なりを直す** stops it. Camera frames remain in the browser and no microphone is requested.

Face tracking runs in a worker at up to 30 frames per second, preferring GPU
with CPU fallback. When a face is lost for about half a second, the character
returns gradually to its normal motion. Angles are conservatively limited for
flat PSD layers; results still depend on the source artwork. This does not
create missing expression artwork or certify motion quality.

Use the local Vite development or preview server for camera tracking. The
model and pinned installed JavaScript/WASM are served locally in both modes.
A standalone static copy of `dist/` does not provide these local API endpoints.

`npm run preview:qa` checks synthetic camera start/stop, permission and device
errors, cancellation during startup, direct tracking-input pixel changes,
375 px layout, and network isolation. Camera inference is explicitly marked
skipped if the verified model is missing; QA never downloads it. To run the
same suite against a production build, first run `npm run preview:build`, then
`WEBUI_QA_SERVER=preview npm run preview:qa` (set `WEBUI_QA_PORT` if needed).

## Show the character in OBS

In **カメラで動かす**, choose a background under **配信ソフトに映す**, then
copy the stream URL. In OBS, add a **Browser** source, paste the URL, and set
both width and height to **1080**. Use **配信画面を開く** to check it in a
separate browser window. Only generated PSDs selected from the saved-file list
are available; files opened directly in the browser cannot be used for streaming.

The stream page shows only the character, with transparency by default. Green,
blue, and a custom color are also available. The URL uses a stable opaque PSD
identifier; restarting the server preserves it while that generated file stays
in the same output location. Removing or renaming the PSD invalidates its URL.
The optional `fit=cover` crops to fill the frame; `contain` is the default.

Camera motion and motion settings are sent to the stream page through the local
server. Camera images are never sent. If updates stop for one second, the
character fades back to its normal idle movement and blinking. Multiple source
pages use a short exclusive lease to avoid alternating poses; close the previous
source page before controlling the same PSD from another page. The connection
count counts open stream pages, including browser previews and OBS sources.

Both `npm run preview` (the development server) and the built preview server
support streaming without development hot reload. Port changes also change the
URL. For a fixed development URL use
`npm run dev --workspace @still2rig-psd/webui -- --port 5173 --strictPort`.
For a built preview run `npm run preview:build` followed by
`npm run preview --workspace @still2rig-psd/webui -- --port 4173 --strictPort`.
Keep the server running while OBS uses its URL.

A worker clock keeps capture and sending independent of page animation frames.
Track processing is used when the browser provides it, with a local video-frame
fallback. Some browsers or operating systems can still slow down minimized
pages; the camera tab displays a notice when background capture falls below
approximately 15 frames per second. Bringing the page forward can restore it.

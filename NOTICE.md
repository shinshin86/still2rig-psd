# Third-party notices

Still2Rig PSD orchestrates, but does not redistribute, these projects:

- [See-through](https://github.com/shitagaki-lab/see-through), Apache License
  2.0. The default worker checks out a pinned upstream revision.
- [colab-mcp-go](https://github.com/shinshin86/colab-mcp-go), Apache License
  2.0. It connects a local MCP client to a user-controlled Google Colab tab.
- [ag-psd](https://github.com/Agamnentzar/ag-psd), MIT License. It is installed
  from npm to write and validate PSD files locally.
- [Anime2.5DRig](https://github.com/852wa/Anime2.5DRig), MIT License,
  Copyright (c) 2026 hakoniwa. `webui` redistributes the upstream
  `lib/rigger.js` runtime and includes a derived WebGL preview renderer. The
  license text is retained at
  `webui/third-party/Anime2.5DRig-LICENSE.txt`.

The optional camera preview uses [MediaPipe](https://github.com/google-ai-edge/mediapipe),
Copyright The MediaPipe Authors, licensed under the Apache License, Version 2.0.
`@mediapipe/tasks-vision` is pinned to 0.10.21. Its JavaScript and WASM are
served from the local npm installation. The unmodified Face Landmarker float16
model, version 1, is downloaded separately into the ignored local data directory;
it is not included in the repository. Source:
https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.
See the [Apache-2.0 license](https://www.apache.org/licenses/LICENSE-2.0).

Model weights downloaded by See-through may have their own terms. Review the
upstream model cards before commercial use. Google Colab usage is subject to
Google's terms and account limits.

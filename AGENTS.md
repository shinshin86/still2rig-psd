# Still2Rig PSD agent guide

Treat this folder as a future public repository.

## Operating rules

- Use `npm run still2rig-psd -- ...` for job creation, Colab cells, import, PSD
  assembly, and QA. Do not replace manifest-backed steps with scratch scripts.
- Keep source images, Colab bundles, PSDs, contact sheets, tokens, logs, and
  generated cells under the ignored `.still2rig-psd/` directory.
- Never add API keys, cookies, Google account details, personal images, chat
  transcripts, local absolute paths, or model weights to tracked files.
- Do not run `git init`, commit, push, publish a package, or create a release
  unless the user explicitly asks for that separate action.
- Do not change `~/.codex/config.toml`. This project uses its own trusted
  `.codex/config.toml`.

## Google Colab

- Use the repository skill at `.agents/skills/still2rig-psd/SKILL.md`.
- Use Colab MCP Go only. Never use Chrome control, browser automation, or
  Computer Use for this workflow.
- The user chooses the Chrome profile, signs in, approves the MCP connection,
  and selects the L4 runtime.
- Never disconnect or delete the user's runtime unless the user explicitly
  requests that action in the current turn.

## Quality claims

- See-through separates visible and inferred layers; it does not create a
  trustworthy blink or opposite mouth state from a neutral image.
- Missing or placeholder expression layers must keep `productionReady=false`.
- Body layers must remain behind neck and face in back-to-front PSD order.
- Do not claim paper-slip, seam, or hair-motion quality without a passing
  `npm run still2rig-psd -- motion-qa JOB` report for the current PSD. The
  report covers the built-in preview renderer only.
- Expression art from `derive-expressions` is a stopgap preview. Use it only
  when neither drawn nor image-generated expression files are available, pass
  it only with `--preview-expressions`, and never describe it as drawn blink or
  lip-sync art.

## Local PSD preview

- Use `npm run preview` to inspect finalized PSDs. The built-in WebUI lists
  files under the ignored `.still2rig-psd/jobs/*/output/` directories.
- Do not copy private PSDs or generated screenshots into `webui/`.

## User-facing language

- Write UI labels, status messages, and help text for people using the tool for
  the first time. Prefer plain, natural Japanese whose meaning is clear without
  prior technical knowledge.
- Avoid exposing implementation terms such as `job`, `WebGL`, `parameter`,
  `runtime`, `manifest`, or internal QA names in the UI. If a technical term is
  unavoidable, explain it in plain language at the point where it appears.
- Name controls by what the user can do or what will change, rather than by the
  underlying implementation. For example, prefer 「細かい設定」 over
  「上級パラメーター」 and 「最初の値に戻す」 over 「既定値へ戻す」.
- When changing visible wording, review nearby labels for the same problem and
  verify the rendered screen before reporting completion.

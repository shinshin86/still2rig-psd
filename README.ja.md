# Still2Rig PSD

1枚のアニメキャラクター静止画像を、AIコーディングエージェントとSee-through
(Google ColabのGPUまたは手元のGPU)で分解し、構造検証済みPSDへ仕上げ、
組み込みWebUIですぐに確認するためのプロジェクトです。

[English README](README.md)

![レイヤーPSDのキャラクターと動作設定を表示したStill2Rig PSDのWebUI](docs/assets/still2rig-psd-webui-preview.webp)

生成したPSDを組み込みWebUIで読み込み、目・口の切り替え、自動まばたき、髪・全身の
動き、表示位置、拡大縮小を確認できます。

Still2Rig PSDは、AIコーディングエージェントから使います。画像を添付して変換を
依頼すると、エージェントが作業の準備、See-throughでの分解、結果の検証、
PSD組み立て、品質確認まで進めます。
下の「はじめかた」では、Codexと、ユーザーが承認したGoogle Colabを使う手順を
説明しています。Colabを使う場合、Googleへのログイン、使用するChrome
プロファイル、GPU、Colab接続の承認はユーザーが管理します。
Codex、Claude CodeをはじめとしたAIエージェントで動き、See-throughはColabの
代わりに手元のGPUでも動かせます。使い方は「Codex以外のエージェントや、
手元のSee-throughで使う場合」の節を参照してください。

> **現在はv0.1 alphaです。** ニュートラルな静止画像1枚だけから、正しい閉じ目や
> 別の口形を常に生成できるわけではありません。不足している表情素材を
> プレースホルダーで隠さず、制作上の残作業として報告します。

## 使用している技術

- [See-through](https://github.com/shitagaki-lab/see-through)：静止画像を意味のある
  パーツごとに分離
- [Colab MCP Go](https://github.com/shinshin86/colab-mcp-go)：ユーザー承認後の
  Google ColabをCodexから操作
- ローカル処理：ハッシュ検証、レイヤー整理、PSD組み立て、構造品質の確認
- 組み込みWebUI：まばたき、口、全身、髪揺れ、ドラッグ、拡大縮小の確認と、
  前後の重なり修正・変更前比較・元PSDを残した別名保存

## Codex以外のエージェントや、手元のSee-throughで使う場合

このREADMEの手順は、CodexとGoogle Colabの組み合わせで書いていますが、どちらも必須ではありません。Codex、Claude CodeをはじめとしたAIエージェントで動き、See-throughはColabの代わりに手元のGPUでも動かせます。

- **Codex以外のエージェント（Claude Codeなど）**：作業の手順は`.agents/skills/still2rig-psd/SKILL.md`と`AGENTS.md`に書いてあります。エージェントにこの2つを読んでもらい、静止画をPSDにするよう依頼してください。Colabを使う場合は、`.codex/config.toml`と同じ内容で`scripts/start-colab-mcp.sh`をMCPサーバーとして登録する必要があります。登録方法はエージェントごとに異なります。
- **手元のSee-through**：Colabの代わりに自分のPCのGPUでSee-throughを動かす場合は、エージェントに「Colabは使わず、手元のSee-throughでレイヤー分けして」と伝えてください。このリポジトリには手元で実行するためのコマンドを同梱していないため、See-throughの準備と実行はエージェントと相談しながら進めることになります。分離結果をこのプロジェクトの形式に合わせて取り込めば、その後のPSD組み立て、品質確認、WebUIでの確認はColabの場合と同じです。

## はじめかた

### 1. 必要なものを用意する

- Codex CLI、IDE拡張、またはデスクトップアプリ
- Node.js 20.19以上
- Python 3.9以上とPillow
- Go 1.25以上
- L4ランタイムを利用できるGoogle Colabアカウント

プロジェクト直下で次を実行します。

```bash
npm install
python3 -m pip install -r requirements-local.txt
go install github.com/shinshin86/colab-mcp-go/cmd/colab-mcp-go@v0.0.0-20260824110853-5c9e997958bf
npm run doctor
```

Codexを起動する前に、`$(go env GOPATH)/bin`へ`PATH`が通っていることを確認して
ください。
インストールコマンドは、このプロジェクトで動作確認したColab MCP Goの版に固定
しています。

### 2. このプロジェクトでCodexを起動する

プロジェクト直下をCodexで開き、プロジェクト固有の`.codex/config.toml`を信頼
します。現在のセッションにColab MCPツールが表示されない場合は、一度Codexを
再起動してください。グローバルなCodex設定を書き換える必要はありません。
接続用のローカルポートは空いている番号が自動選択されるため、別のCodex
プロジェクトが起動したColab MCPとも共存できます。

Colab MCP Go本体は、このリポジトリに同梱していません。手順1でインストールした
`colab-mcp-go`を、プロジェクト設定から必要なときに起動します。このプロジェクトは、
すでに動いているグローバル側のプロセスを探して再利用するのではなく、専用の
プロセスを空きポートで起動します。ほかのプロセスを終了する必要はありません。
Codexの再起動が必要なのは、MCP設定を現在のセッションへ読み込ませる場合です。
PSDを作るたびに再起動する必要はありません。

### 3. 画像を渡してCodexへ依頼する

PNG、JPEG、WebPのアニメキャラクター画像を添付するか、ローカルファイルの場所を
伝えて、次のように依頼します。

```text
$still2rig-psd を使って、このアニメキャラクターの静止画像を、私が承認する
Google Colabセッション経由で検証済みレイヤーPSDに変換してください。
接続後は、結果の取り込み、PSD組み立て、品質確認まで進めて、最後にプレビューの
開き方を教えてください。
```

Codexは次の作業を進めます。

1. 画像をGit管理外の作業場所へコピーし、SHA-256を記録する
2. Colabで使うアップロード、準備、分離、ダウンロード用セルを生成する
3. トークン付きColab URLを表示し、ユーザーの接続承認を待つ
4. 承認されたL4ランタイムで、固定したSee-throughを実行する
5. ダウンロード結果を検証し、レイヤーを整理してPSDを組み立てる
6. 構造品質を確認し、生成PSDと残っている表情・動作上の課題を報告する

Colabが結果ZIPをブラウザへダウンロードしたあと、Codexがファイルを自動で
見つけられない場合は、ダウンロード先の場所を伝える必要があります。

Colab URLには接続用トークンが含まれます。公開、共有、スクリーンショットへの掲載は
しないでください。

### 4. 生成PSDを確認する

組み込みプレビューを起動します。

```bash
npm run preview
```

表示されたローカルURLを開いてください。WebUIは
`.still2rig-psd/jobs/*/output/`にある生成PSDを一覧表示し、最新結果を選択します。
手元にある別のPSDも、ファイル選択またはドラッグ＆ドロップで読み込めます。
生成済みPSDは「保存先を開く」から、Finderやエクスプローラーで出力フォルダを開けます。
PSDを開く前の画面では、「画像から新しくPSDを作る」からCodex／Claude Code向けの
変換の依頼文をコピーできます。エージェントに貼り付け、最後の行に画像ファイルの場所を
書き足して送ってください。選んだ依頼先は次回も引き継がれます。
「重なりを直す」では、人物上の直したい部分をクリックして選び、腕・手や前髪などを
手前／奥へ移動できます。重なった場所では候補から選び、変更前と比較してから、
元のPSDを上書きせず修正版を別ファイルとして保存できます。PSDの組み直しに時間が
かかる場合は、プレビュー上に処理中の内容を表示します。細かい並べ替えはPCのマウスで
右端の点々をドラッグして行えます。スマートフォンのタッチ操作には対応していません。

### 5. 表情の絵を用意する

生成済みPSDを選ぶと、「表情の絵を作ってもらう」から、まばたきと口パク、笑顔、
照れ、怒り、悲しみ、驚き、焦り、ジト目を選んで依頼文をコピーできます。
一覧と依頼パネルは最初は閉じています。一覧の見出しに、足りない絵がある表情の数を
表示します。足りない絵は最初から選ばれています。入っている絵を変えたい場合は、
表情ごとの「作り直す」を選び、任意で希望を書けます。同じ絵を使うほかの表情も
一緒に変わります。たとえば笑い目は、笑顔とウィンクで共通です。

**Codex**を選ぶと、顔の画像がCodexの画像生成に送られることが表示され、
依頼文のコピーをもって送信に同意したことが依頼文に書き込まれます。
1回の依頼で、選んだ表情の絵をまとめて用意します。各絵を1枚ずつ生成し、
取り込みの検査と目視確認を通った最初の絵を採用します。通らない絵だけ最大2回まで
作り直し、それでも通らなければ、その絵は見送ってほかの絵を進めます。
見送った絵がすでに入っている場合は、その絵を残します。
採用した絵をまとめて取り込み、最後に全表情の一覧、作り直し回数・見送り理由、
検査結果を報告します。途中で候補を選んだり、表情ごとに承認したりする必要はありません。

**Claude Code**は画像を生成できないため、全ての依頼用ファイルを用意し、
承認した画像生成サービスへ渡すものと、各結果の保存先をまとめて案内します。
画像を保存したことを伝えると、同じ検査・目視確認・取り込みの手順を進めます。
手元から開いたPSDには必要な変換時のデータがないため、パネルではその旨だけを表示します。

直接操作する場合は、次の順で実行します。

```bash
npm run still2rig-psd -- expression-requests demo --only eyes_sad,mouth_frown
# 送信を承認したあと、それぞれのinput.png、mask.png、prompt.txtで1枚ずつ生成します。
# results/eyes_sad.pngとresults/mouth_frown.pngに保存します。
# PSDを変更せずに各画像を検査し、出力された画像も目視で確認します。
npm run still2rig-psd -- import-expressions demo --only eyes_sad --read-only --preview-dir .still2rig-psd/review/demo/eyes_sad
npm run still2rig-psd -- import-expressions demo --only mouth_frown --read-only --preview-dir .still2rig-psd/review/demo/mouth_frown
# 両方が検査と目視確認を通ったら、まとめて取り込みます。
npm run still2rig-psd -- import-expressions demo --only eyes_sad,mouth_frown
npm run still2rig-psd -- repair demo --expressions .still2rig-psd/jobs/demo/generated-expressions
```

目視では、意図した表情に見えるか、元の絵柄・線の太さ・色に合っているか、
目・眉・口が二重になっていないか、指定範囲の外に描き足していないかを確認します。
全ての画像の確認と取り込みが終わるまで、依頼用ファイルと記録されたハッシュ値は
変更しないでください。`--only`は指定した絵だけを検査・置き換え、ほかの取り込み済みの絵を残します。
2回作り直しても通らない絵は、最後の取り込み対象から外します。採用できる絵が
1枚もなければ、`repair`は実行せずに理由を報告します。通すために検査基準を緩めないでください。

`expression-candidates`と`import-expressions --pick`は、候補の番号を指定する
比較や開発用に引き続き使えます。読み取り専用の確認では、元のPSD・設定・
取り込み済みの絵を変更しません。`--preview-dir`で確認画像の保存先、
`--request-dir`で保存済みの依頼を指定できます。保存先は`.still2rig-psd/`内で、
元のデータと別の場所にしてください。検査合格だけでは、絵の品質を確認したことにはなりません。

依頼用の画像は、最新の修復を含むPSDレイヤーから、前髪・頭の装飾を隠して顔を
切り抜きます。取り込みでは、顔の下地と同じ画素を除き、新しい表情の描画だけを
PSDと同じ寸法・位置へ戻します。
依頼後のレイヤー変更、縦横比の違い、画像全体の位置ずれ、編集範囲の周囲の大きな変更は拒否します。
手描きの素材を優先し、生成した絵も既存の表情検査と目視確認を行ってください。
取り込みが通っただけでは、絵の品質を確認したことにはなりません。
`repair`は前回の修復で使った差し替え画像を自動で引き継ぎ、引き継いだ内容を表示します。
取り除く場合だけ`--no-layer-overrides`を指定してください。古い修復の差し替え画像を
見つけられない場合は処理を止め、画像の場所か、引き継がないことの指定を求めます。

## 自動化される部分とユーザーが行う部分

| Codexが行うこと | ユーザーが行うこと |
| --- | --- |
| ローカル作業の準備とColab用セルの生成 | 使用するChromeプロファイルとGoogleアカウントの選択 |
| 接続承認後のSee-through実行 | Colab URLを開き、L4ランタイムを選択 |
| ダウンロード結果とハッシュの検証 | Colab MCP接続の承認 |
| レイヤー整理、PSD組み立て、構造品質の確認 | ランタイムを終了・削除するタイミングの判断 |
| 出力場所とプレビュー方法の報告 | 元画像にない正しい表情素材の用意 |

Still2Rig PSDは、Chromeの自動操作、Googleへのログイン、アカウント選択、ランタイム
割り当て、グローバルCodex設定の変更、Colabランタイムの終了・削除を行いません。

## 出力されるファイル

作業ごとのデータは、Git管理外の`.still2rig-psd/jobs/<名前>/`に保存されます。

```text
.still2rig-psd/jobs/<名前>/
  input/                 コピーした元画像
  colab/                 生成したColab用セル
  raw/imported/          検証済みのSee-through結果
  processed/layers/      整理したキャンバス全体のレイヤー
  output/<名前>.psd      組み立てたPSD
  reports/               コンタクトシートと品質確認結果
  job.json               ハッシュ、設定、処理記録
```

元画像、生成PSD、Colab接続トークン、ログ、スクリーンショット、動画、モデル、
ダウンロードZIPは、既定でGit管理対象外です。

## 品質確認と制限

現在のCLIが自動報告するのは、次のうち最初の2段階です。後の段階は前の段階を
満たしたうえで報告します。3段階目は`motion-qa`の結果で、内蔵のプレビュー用
レンダラーで動きを収録し、`configs/motion-qa-contract.json`の検査で評価します。

| 状態 | 意味 |
| --- | --- |
| **構造確認済み** | 設定順でPSDを書き出し、必須レイヤーと重要な前後関係の構造QAを通過済み。ハッシュは処理全体の別工程で確認します。 |
| **口・閉じ目ファイル自動検査済み** | `mouth_open`と`eye_close`があり、組み込みプレースホルダーではなく、位置合わせと口の数値検査を通過済み。絵として正しいかは目視確認が必要です。 |
| **アダプターによる動作確認済み** | `motion-qa`で内蔵のプレビュー用レンダラーの動きを収録し、定めた検査をすべて通過済み。ほかのレンダラーは対象外です。 |

標準の前後順は、奥から`back hair` → 下半身の服 → 腕 → 上半身の服 → 首 → 耳 →
顔 → 目・眉・鼻・口 → `front hair` → 頭の装飾です。横に下ろした腕を服より後ろへ置くため、今回の
ような肩口で腕が服を突き抜ける表示を防ぎます。ただし、胸の前へ出した手は同じ
順番では扱えません。その場合は腕を前後のパーツに分割する必要があります。

元画像に開き口や閉じ目が写っていない場合、本物の口・まばたき素材は自動では
確定できません。`--preview-placeholders`は操作確認用であり、実際の表情素材としては
扱いません。表情画像は、描いたものか画像生成ツールで作ったものを`--expressions`で
渡すことを優先してください。どちらも用意できない場合の応急処置として、
`derive-expressions`で元のレイヤーから仮の開き口と閉じ目を描けます。
`--preview-expressions`で渡すとプレビューで動きを確認できますが、`productionReady=false`
のままです。

詳しい前後順、必要な表情画像、各状態の判定範囲は
[生成されたPSDで確認できていること](docs/quality-gates.ja.md)を参照してください。
ワンクリックでLive2D制作が完成するとは保証しません。

## コマンドを直接使う場合

通常はリポジトリ内のスキルに従ってCodexが実行します。調査や手動操作では、次の
コマンドを直接利用できます。

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

`repair` は検証済みの取り込み結果を再利用するため、Colab推論をやり直しません。
現在のPSDとレポートをGit管理外のジョブ領域へ退避し、隔離された修復領域で
再構築と構造QAを完了してから、WebUIが参照するPSDを更新します。

## セキュリティとプライバシー

- Colab MCPはlocalhostだけで待ち受け、ランダムな接続トークンを必要とします。
- 元画像と生成セルは、処理のためユーザーが承認したColabへ送信されます。ランタイムは
  ユーザーが終了するまで割り当てられたままです。
- 組み込みプレビューは`127.0.0.1`で待ち受け、Git管理外の生成PSDだけを提供します。
- 受け取ったZIPは信頼せず、パストラバーサル、シンボリックリンク、容量制限、
  ハッシュ不一致を検査します。
- 必要な権利を持たない元画像や生成物を公開しないでください。

詳細は[セキュリティ、プライバシー、承認境界](docs/security.md)を参照してください。

## ライセンス

Still2Rig PSDはMITライセンスです。See-throughとColab MCP Goは別個の
Apache-2.0プロジェクトです。プレビューにはMITライセンスのAnime2.5DRig
`rigger.js`をライセンス文とともに収録しています。外部ツールがダウンロードする
モデルには、追加の利用条件が設定されている場合があります。

第三者ライセンスについては[NOTICE.md](NOTICE.md)を参照してください。

## 関連ドキュメント

- [CodexとColabの処理手順](docs/codex-workflow.md)
- [構成と処理記録](docs/architecture.md)
- [生成されたPSDで確認できていること](docs/quality-gates.ja.md)
- [セキュリティ、プライバシー、承認境界](docs/security.md)
- [トラブルシューティング](docs/troubleshooting.md)
- [組み込みPSDプレビュー](webui/README.md)

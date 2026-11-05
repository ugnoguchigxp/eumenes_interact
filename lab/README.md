# lab 実験用ホスト

plan.md §3.1の「実験用ホスト」。Arm 0（現行Eumenesのブラウザ担当の移植）を、fixtureと実サイトで動かし、測る。コマンドは`bun lab/cli/main.ts`（ルートの`package.json`の`lab`スクリプトで`bun run lab`）。

## Claude APIで動かす（.env）

モデルはClaude API（既定は**Claude Haiku 5.5（`claude-haiku-5-5`）、effort `low`**）。鍵は環境変数で渡す。

1. リポジトリ直下に`.env`を作り、`ANTHROPIC_API_KEY=<あなたの鍵>`と書く（`.env`はgitignore済み。コミットしない）。
2. リポジトリ直下から実行すると、Bunが`.env`を自動で読む。別のディレクトリから実行しても、鍵が環境に無ければホストが`<repo>/.env`を読む。
3. 鍵が見つからないときは、何も開く前に`claude_credential_missing: put ANTHROPIC_API_KEY=… in <repo>/.env`で止まる。鍵は表示も保存もしない（ログ・DB・transcriptに入らない）。

指定できるもの（`run`、`compare`、`operate`で共通）:

- `--inference claude`（`run`は`scripted|larm|claude`、`compare`は`scripted|claude`、`operate`は`claude|larm`）
- `--model <id>`（既定`claude-haiku-5-5`）、`--effort low|medium|high|xhigh|max`（既定`low`）。`--model`と`--effort`は`--inference claude`のときだけ。
- モデルとeffortは、実行ごとに凍結される。試行の`inference_json`に`provider`、`model`、`effort`が残る。
- Claudeの実行はお金がかかる。実行は利用者の指示で始める（開始時に注意を1行出す）。

## 測る（トークンと費用）

fixtureのdevケースをClaudeで測る:

```
bun lab/cli/main.ts run --split dev --inference claude --repeat 3
bun lab/cli/main.ts report --experiment <実験id>
```

- `report`の`usage`に、プラットフォームと推論の組ごと、全体とケースごとに、次が出る。
  - 非キャッシュ入力（Claudeの`input_tokens`はキャッシュを含まない）・出力・キャッシュ読み・キャッシュ書きのトークンの合計（未取得があれば`null`。0にはしない）と、成功した試行での中央値
  - プロンプト総量（`prompt total` = 非キャッシュ入力 + キャッシュ読み + キャッシュ書き）。プロバイダ間で比べるのはこの数字
  - モデル呼出し回数の合計と中央値
  - 費用の**推定**（list priceからの見積もりで、請求額ではない）。1試行あたりと、成功した1試行あたり（失敗の費用も成功の費用に含める）
  - 成功率（全試行が分母。終わらなかった試行も、セッションを開けなかったケースも失敗として数える。モデル呼出し回数が不明な試行は`null`）
  - 自由な依頼（`operate`）は採点しないので、この表にも成功率にも入らない

プラットフォームの比較（`compare`）にも同じ表が付く:

```
bun lab/cli/main.ts compare --split dev --definitions none --inference claude --repeat 3
```

- `lab/data/reports/compare-<時刻>.{json,md}`の「Tokens and estimated cost」に出る。比較の実験には、実際の推論の種類（`claude`など）とモデル・effortが凍結され、`report`の`experiment.inferenceFrozen`に出る。定義（`task run`の作業定義）はモデルを使わないので、トークンの列は空。

## 自由な依頼を実サイトで動かす（operate）

plan.md §13.1の最小の契約（start・status・cancel）の、CLIとホストAPI。依頼を、許可したoriginの中だけで、Arm 0と実際のモデルが実行する。

```
bun lab/cli/main.ts operate \
  --request "YouTubeで「AI research」を検索して、検索結果の動画を1本再生してください。" \
  --start-url https://www.youtube.com/ --allow-origin https://www.youtube.com \
  --inference claude
```

- `--allow-origin`は必須で、何度でも書ける（`https://host[:port]`、または`https://*.domain`でそのドメインとサブドメイン）。開始URLのoriginが許可に入っていること。
- `--max-calls n`は1〜12（Arm 0の上限。既定12）。`--approver stop|cli`（既定`stop`: 承認が要る操作で何も送らず`needs_input`で止まり、何をしようとしたかを表示。`cli`は端末で答える）。
- URL方針は`run`と同じ（許可origin以外とloopback・privateは拒否）。単一runnerのロックと再起動時の照合も同じ。実行中に別の`run`/`operate`/`task run`/`compare`を始めると`runner_active`で拒否される。
- 終わると、最終文、状態、最終URL、モデル呼出し回数、操作数、トークン、費用の推定を表示する。`--json`はスナップショットをJSONで出す。`--keep-observations`は観測を`lab/data/observations/<runId>/`に最大7日間残す（既定では実サイトの観測を保存しない）。
- 実行は保存される（`interact_runs`、`lab_trials`のtranscript）が、期待する結果が無いので採点はしない（`score_json`は空）。依頼の本文は保存しない（ダイジェストだけ）。実サイトの実行は、`--keep-observations`が無ければモデルの最終文も保存しない（transcriptの`step.final`と`stop_json`には種類・コードと文字数だけ。`onEvent`とスナップショットでは本文が見え、`operate`は画面に出す）。fixtureの実行と`--keep-observations`では本文を保存する（採点の`answerIncludes`が読む）。

プログラムからは`lab/host/operate.ts`の`startOperate(options)`:

```ts
const handle = startOperate({ request, startUrl, allowedOrigins, inference: "claude", approver: "stop" });
handle.runId;        // 開始前に決まっている
handle.snapshot();   // 状態、最終文、トークン、費用の推定…を、実行中も取れる
handle.cancel();     // 取り消し
await handle.done;   // 終わったときのスナップショット
```

別のrunnerが動いていると`RunnerActiveError`を投げる。`arm`（既定`"arm1"`）、`captureDir`、`maxTokens`も渡せる。スナップショットには`arm`、呼んだ部品の列`parts`、撮影先`captureDir`と保存したファイル名`captures`が入る。

## 部品で動かす（Arm 1）

plan.md §6.4。モデルは、登録された部品（`page.open`・`site.search`・`item.open`・`page.read`・`page.capture`・`form.fill`・`form.submit`など）とその引数のJSONを1回に1つだけ選ぶ。ref・Playwright MCPのツール・待ち方・新しいタブへの追従は、`lab/host/parts/`の部品の実装に閉じる。

```
bun lab/cli/main.ts run --case dev-capture-results --arm arm1 --inference scripted
bun lab/cli/main.ts run --split dev --arm arm1 --inference claude --max-tokens 4000 --capture-dir /abs/dir
bun lab/cli/main.ts operate --request "..." --start-url ... --allow-origin ... --arm arm1 --capture-dir /abs/dir
```

- `--arm arm0|arm1`は`run`・`compare`・`operate`にある（`run`と`compare`の既定は`arm0`、`operate`は`arm1`）。実験・試行・レポートに記録され、実験に凍結される（`report`の`experiment.frozenArms`、利用量表の`arm`）。Arm 1は構造化出力が要るので`--inference larm`とは組み合わせられない（実行前に拒否）。
- `--max-tokens n`（256〜64000、`--inference claude`のみ）は、1回の呼出しの出力の上限。モデル・effortと同じく実験に凍結され、試行の推論情報にも入る。
- 部品の中の各操作は、Arm 0と同じ検査を通る（URL方針、承認の判定、台帳の`dispatched`、古いrefの拒否、結果不明の再送禁止）。結果不明の操作が出たら部品も`indeterminate`で終わり、runが止まる。承認が要る操作は送らずに止まる。`form.submit`は宣言された送信なので、必ず承認を聞く。検索ボタンなど確定でないものは`item.open`で開く。
- 項目IDは`p<ページ>.i<番号>`。要約・一覧・フォームは同じページなら同じIDを共有する。クリック・ナビゲーション・待機のあとは新しいページIDになり、古いIDは`item_expired`（要約つき）になる。IDが最新の観測で1つに引き直せなければ、推測せず`target_not_found`か`target_ambiguous`と候補を返す。ホストの発行していないIDは`item_unknown`。
- `item.open`・`form.submit`でクリックが新しいタブを開いたら、タブの一覧を前後で比べて、新しいタブへ切り替えて要約する（Arm 1だけ。Arm 0はEumenesどおり）。
- `form.fill`の値の出所はArm 0と同じ。依頼文の引用か、利用者が承認した値（`reference.approved`）だけ。それ以外は`needs_input`で、入力しない。selectは選択肢の表示名で選び、チェックボックス・ラジオは依頼文にある根拠（モデルが書いた語句か、選択肢のラベル）があるときだけクリックする（外すのは根拠が要らないが、ラジオは外せない）。`site.search`の語は、各語が依頼文の一部であること。
- スクリーンショット（`page.capture`）は、呼出し元が実行ごとに決めた**撮影先**に保存する（`--capture-dir <絶対パス>`、`startOperate`・`runDefinition`の`captureDir`）。実在する絶対パスのディレクトリだけで、symlinkをたどった実体を検査し、その外へは書かない。既存のファイルは上書きしない（排他的に作る）。ファイル名はホストが`<runの先頭8文字>-<番号>-<範囲>.png|jpg`と付け、モデルは撮影先もファイル名も決められない。指定が無ければ`lab/data/captures/<runId>/`に置き、7日を過ぎたものは次の実行の開始時に消す。結果としてモデルに返すのは画像のID・大きさ・ファイル名だけ。画像をAIに渡す処理はEumenes側の責務。
- 記録: `part.call`（部品名と引数の名前だけ。値は入れない）、`part.result`（部品名・状態・コード）、`capture.saved`（IDとファイル名・大きさ・バイト数・形式・範囲）。転写の`captureDir`には撮影先の絶対パスが入る（転写だけ。ログには出さない）。画像もパスもログには出ない。
- Arm 1の固定応答（`--inference scripted`）は`lab/scripted/scripts-arm1/<caseId>.json`。モデルがするのと同じ部品の呼出しJSONを、最新の結果の要約から役割・名前・領域で項目を選んで作る。選べない・複数あるときは聞き返す。Arm 0には撮影の道具が無いので、撮影のケースはArm 0では失敗する（仕様）。`run`の終わりと`operate`は、呼んだ部品の列と保存した撮影を表示する。

## そのほかのコマンド

`cases`、`run`、`trials`、`report`、`larm`、`knowledge`、`task`、`compare`は`bun lab/cli/main.ts`のusageを見る。作業定義は[definitions/README.md](definitions/README.md)、ケースと採点は[cases/README.md](cases/README.md)。

## eumenes-collaboration の同期

`lab/package.json` は `eumenes-collaboration` を `file:../../eumenes_collaboration` で参照し、bun はハードリンクのコピーとして入れる。整形ツールなどでソース側のファイルが置き換わるとリンクが切れ、lab は古いコピーを動かし続ける。collaboration を変更したら `bun install` を実行し、`bun run check:collab` で確認する（`bun test` の `lab/test/host/collab-sync.test.ts` も差分があれば失敗する。ソースが隣に無い環境ではスキップ）。

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
  --inference claude --headed
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

別のrunnerが動いていると`RunnerActiveError`を投げる。

## そのほかのコマンド

`cases`、`run`、`trials`、`report`、`larm`、`knowledge`、`task`、`compare`は`bun lab/cli/main.ts`のusageを見る。作業定義は[definitions/README.md](definitions/README.md)、ケースと採点は[cases/README.md](cases/README.md)。

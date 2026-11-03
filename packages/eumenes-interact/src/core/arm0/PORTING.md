# Arm 0 の移植元と差分

Arm 0 は、Eumenes の現行ブラウザ担当（page operator）の1手処理を純粋な処理核へ移したものです（plan.md §4, §10.3）。

- 移植元: Eumenes commit `98b188d2c61352d2278b1912a78e8cd465d37671`（`/Users/y.noguchi/Code/eumenes`）
- 定数: `ARM0_SOURCE_COMMIT`（`source.ts`）
- 一致の確認: `test/core/arm0-golden.test.ts`。正本のgoldenは `lab/arm0-golden/generate.ts` が、Eumenes の純粋な関数を上記commitの内容で読み込んで書く（`lab/arm0-golden/golden/`）。

## 移植したもの

| 本パッケージ | Eumenes（commit 98b188d2） |
| --- | --- |
| `task.ts` | `api/domains/inference/contracts/agent-task.ts`（TaskState, startTask, taskMessages, recordOutput, recordToolResult, rewriteReferences, taskViolations, parseTaskAction）と、`agent-core.ts`（agentControl, agentSystemMessage, rejectedOutputMessage, toolResultMessage, retriesFor）、`contracts/index.ts`（controlInstructions, promptTime） |
| `json.ts` | `api/infrastructure/llm-json.ts`（jsonrepair。loggerを除き、`Buffer.byteLength` をUTF-8長の自前計算に置換） |
| `fold.ts` | `api/application/browser/browser-fold.ts`（expireObservations） |
| `text.ts` | `api/application/browser/browser-text.ts`（clip, placeOf, originOf, squash, addSeen, fromPage）、`api/infrastructure/jst-time.ts`（jstIso） |
| `observation.ts` | `api/domains/browser/service/observation.ts`（boundSnapshot, snapshotNodes）と `contracts/index.ts` の `SNAPSHOT_MAX_*` |
| `schemas.ts` | `api/domains/capabilities/contracts/browser.ts` と `inputs.ts`（ツール入力のzod schema。説明文まで同じ） |
| `result.ts`, `tools.ts` | `api/application/browser/browser-task-tools.ts`（HINTS, argumentHints, refusal, observationView, tabLine, `PAGE_TOOLS` の検査）。Eumenes の `assertActionable`（`domains/browser/service/tabs.ts`）と `grants.ts` の引用検査のうち、副作用のない判定 |
| `texts.ts` | `browser.bundle.json` の profile `browser.page-operator@1`・skill `@5`（package `browser.page-operator@5` の版）、`systemContext("browser.contexts.page-operator.rules" / ".reference" / ".correction")` の描画結果、各ツールのsummary |
| `run.ts` | `api/application/browser/browser-task-runner.ts` の `begin`（最初の入力の組立て）と `advance`（1手） |

## 移植しないもの

Eumenes のドメイン機能のため、Arm 0 の対象外です。SKILL本文（文字列一致のため変更しない）にはこれらへの言及が残ります。

| ツール | 移植元 | 理由 |
| --- | --- | --- |
| `browser.page.collect` | `browser-task-tools.ts` `PAGE_TOOLS` | 調査タスク（research child）専用の採取。`compactSnapshot` も同じ経路でしか使わないため移していない |
| `browser.page.script` | 同上、`browserScriptPublish2` | Eumenes の実行Script公開。研究側のJSON定義（plan §6）と別物 |
| `browser.page.history` | 同上、`browserHistoryTarget` | Eumenes の作業履歴。DBが要る |
| `browser.page.connect` | 同上 | Braveへの接続。接続はホストとadapterの責務 |
| `browser.page.capture` | 同上、`browserPageCapture` | 画像撮影。初期範囲外 |
| `browser.page.tab_close` | 同上 | `HostCall` に対応がなく、利用者のタブを閉じる操作は初期範囲に入れない |

`REFERENCE` の `history`、承認待ち操作の再開（`approved` の operation）、`observationError`、`blocks`/`links` 付きの観測（調査タスク用）も移していません。

## 差分（判定と文面は変えていない）

- `recordOutput` が `ParseRecord` も返す。`controlInstructions` は常に `OUTPUT_SCHEMA=` を描く（task の schema に `examples` が無いため）。
- 観測は `ObservationEnvelope` から作る。`tabRef`・`observationRef` はホストが付ける。`browserPageClick` 等のschemaが `z.uuid()` のため、ホストはUUIDで発行すること。
- 最新観測の照合（`observation_stale` / `ref_not_actionable`）はEumenesではホストのDBが行う。処理核が状態に持つ最新観測で同じ判定をし、`call` を返す前に拒否する。ホストも世代を再検査する。
- 入力値の検査（ページ由来の値か、`quote` が依頼の一節か）はEumenesではホストのgrantとツール内で行う。処理核が同じ判定をし、満たさなければ `stop`（`code: "input_value_unconfirmed"`、`approvals: [{kind:"input_value", value, origin, purpose}]`）を返す。文面はEumenesの `valueStop` と同じで、`approvals` は `InputValueApproval` から `variable` を除いたもの。
- `tabLine.status` は常に `idle`（`TabView` に状態が無い）。操作が確認済みで観測が付かなかった結果は `{ok:true,state:"done"}` のみ（Eumenesは観測失敗なら `observationError` を付ける）。
- `browser.page.type` のschemaは `browserPageType2`（承認済みの入力値が `reference.approved` に無いとき）または `browserPageTypeValue2`。検査は常に後者で行う。Scriptが無いので `variable` は `script_variable_unknown` で拒否する。
- `inputValueRef` で入力するとき、`page.fill` の `text` は空で、ホストが許可から値を引く。
- `declaredEffect`: navigate/input/commit は navigation/input/submit。hover は unknown、select は input、wait は none、navigate・back は navigation。
- `shapeObservation` の `truncated` は処理核自身の切詰めだけ。adapterの切詰め（`RawObservation.truncated`）はホストが合わせる。
- 最新観測の `generation` は状態に持たない（処理核は使わず、ホストが `OperationRequest` に付ける）。
- `reference` の扱い: `observation`（最初の観測のenvelope）と `tabs`（`TabView[]`）は `target`・`tabs`・`observation` の表示に変換し、`approved` はそのまま通す。`scriptRequired` は常に `false`。それ以外のキー（`requestedUrl`、`connection` など）はホストが書いた順で `REFERENCE` に入る。
- 結果不明（`indeterminate`）の操作は `failed: tool_refused` で終わる。Eumenesは `operation_indeterminate` で終える。ホストは `HostOutcome` の操作状態を自分で読み、結果不明として記録すること。
- Eumenesの `policy.ts` が行う移動先の検査（私設・ループバックのアドレス、認証情報付きURL、httpとhttps以外のスキーム、`navigation_*_blocked`）は処理核に無い。ホストの責務で、labのホストが移植する。拒否は `HostOutcome` の `refused` で返す（HINTSの文面は処理核が付ける）。
- `tab_new` が確認済みでも観測が付かなかったとき、Eumenesは `work.tabRef` を新しいタブにして、以後の要素操作を `observation_stale` で止める。処理核は新しいタブのrefを知らないため、操作対象のタブを外す（`tabRef` を空にする）。以後の要素操作・observe・navigate などは `no_target_tab` で拒否され、モデルは `tabs` と `tab_select` で選び直す。古いタブのrefが新しいタブへ送られることはない。
- 終了の印: arm0の状態に `ended` を持ち、`failed`・`finish`・`clarify`・`stop`・`stopped` の後は `true` になる。終了後の `prepareStep`・`parseStep`・`applyResult` は `core_run_ended` を投げる。TaskStateの項目は変えていない。
- Agent Browserの観測（プラットフォーム拡張。Eumenesの挙動ではない）: refは `[ref=e26]` のほか、他の属性と同じ括弧の中（`[checked=false, ref=e322]`、`[ref=e27, url=https://…]`）にあってもよい。`observation.ts` の `REF` を、1つの括弧内の属性リストのどこにあるrefも読むようにした。refの文字集合は同じ。Playwright形式の本文では結果が変わらない（goldenは不変）。本文は書き換えない（plan §5.3）。

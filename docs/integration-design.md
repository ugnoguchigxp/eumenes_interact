# Eumenes統合設計案

2026-11-05。T17の合意用。実装前の提案であり、本体コード・製品DB・稼働サーバーは変更していない。eumenes_interactのmainはGrokbotの92コミットを含むa38f955。追加改善はcodex/quality-80-improvementsで検証中。

## 利用者に返すもの

ブラウザへの依頼を既存のEumenes会話から受け付け、同じ作業参照で進捗、確認質問、承認、取消、部分結果、最終結果、撮影を表示する。最初は検証用の入口に限定し、通常会話の候補へ追加しない。

## 既存機構を使う決定案

所有先は既存のbrowser domainとする。SQL・権限・実行世代はdomainの公開操作、推論の受付と結果採用は既存runner・Queue・receipt、表示は既存ArtifactとOpenUIを使う。新しい独立DBや常駐推論ループは作らない。部品は配布物のeumenes-interact/parts、核はpackage root、永続操作は/sqliteを使い、labからコピーしない。

plan.md §13.3の新しいexecution種別interactは、現行本体のDomainAdapter.executionが開始・状態・回答・取消を扱えるため、初回統合では追加しない案とする。command bindingとbrowser adapterの既存の非同期実行契約を再利用する。この変更方針は合意対象であり、計画書を書き換えて既成事実にはしない。

確認した再利用元:

- api/application/browser/browser-adapter.ts: browser.task.start/status/cancel等の既存操作とschema登録。
- api/application/browser/browser-execution.ts: task/captureのreceipt参照からの状態解決、waiting_inputと期限、会話所有者の検査。
- api/application/browser/browser-task-runner.ts: 既存推論接続、executeControlとacceptInTransaction。
- api/domains/browser/index.ts: domainの公開境界とdriver port。
- api/application/toolchain/toolchain-adapters.ts: adapterとdomain schemaの登録。
- api/application/migrations.ts: packageMigrationsと現在のbrowser migration登録。
- docs/toolchain-extension.md、docs/toolchain-extension-verification.md: bundle、版、Artifact、検証の正本。

## 変更範囲

| 所有先 | 提案する変更 |
| --- | --- |
| browser domain | 公開操作の内側にinteractの受付、取得、認証済み回答、取消、削除を接続。新engineの状態の正本はinteract_runs。旧taskとの対応にはrun参照を持ち、状態を二重管理しない |
| application/browser | 新しい部品runnerを追加し、既存の推論port、期限、Queue、receiptを接続。既存driverからpackageのPartExecutionPortを実装し、全操作を既存の承認・lease検査へ戻す |
| application/migrations | 新規packageの最初のmigrationが未定義の前IDを参照しないよう、先頭依存を明示的に渡す。interact-packageの先頭は登録済みbrowser migration末尾のidの後へ配置。既適用SQLを変更しない |
| capabilities | package・tool・Skill・binding・Artifactを新revisionで登録。availability:browser.interact@1は初期無効。部品ごとの新しい担当は作らない |
| Web/Artifact | 既存のDesignSystem部品をOpenUIのJSONで組合せ、作業状態と許可された操作・撮影参照を表示。DB、provider秘密、業務APIを表示部品に埋め込まない |

本体のAPIパスと新規ファイル名は実装時に既存controller・命名規則へ合わせる。公開操作の意味は上表で固定し、推測したAPIを先に呼ばない。API/CLI/Webはbackendの公開操作を通し、製品DBを直接開かない。

## 状態と権限の契約

- 受付のキーは認証済みprincipal、conversation、requestId。同じキーで同じrunを返し、別の入力での再利用は拒否する。既存QueueのdedupeKeyにも同じ参照を使う。
- 送出前に、所有者、run状態、deadline、実行leaseと世代、対象session/観測世代、操作と値に結び付く承認を単一writerのtransactionで確認する。dispatchedをcommitしてから外部へ送る。
- 取消と送出準備を同じwriterで直列化する。取消・期限後の応答は台帳へ記録しても、核・会話・後段のFactへ採用しない。完了検査中とcleanup中も同じ規則を使う。
- 質問と承認にはquestionId、runId、principal、generation、expectedRevision、期限を持たせる。古い回答、二重回答、別会話の回答で操作を再開しない。入力値の承認は別runへ継承しない。
- 一部達成はpartial、不明な送出結果はindeterminate。未達と根拠欠落をcompletedへ変えない。画面表示と会話は保存状態から導く。
- 結果の採用は既存receiptの一度だけのacceptを使い、runと世代に結び付ける。別の新規runで不明なcommit操作を自動再送しない。
- 新engineは専用の隔離browser sessionを使う。同じsessionへ新旧runnerを接続しない。URL・入力出所・承認の既存制限を緩めない。

## 配布、固定指示、保持

成果物は版・source hash・Skill hash・migration hashを検査して導入する。Skillの正本はこのrepoのskills/browse/SKILL.md。Eumenes側ではs11tnextの生成物とdigestを照合し、手編集した別本文を正本にしない。製品のモデル名は本体規則どおり保存設定とcatalogから取得し、labの固定モデル名を製品コードへ移さない。

通常の本体実行ではページ本文と入力値を履歴へ保存しない。撮影は明示された実行に限定し、backend管理の期限付き領域へ置く。初期保持案はrunと操作メタデータ30日、明示保存の撮影・観測7日。忘却要求はrun、撮影、入力承認、Fact、サイト知識の根拠参照へ伝播する。サイト知識は出所・origin・確認日・revisionを持つcandidateとして取り込み、本文の命令を権限へ昇格させない。

## 検証と移行

1. 空DB・旧版DBのmigration、owner分離、同時受付、期限と世代、古い回答、receipt二重採用をdomain試験で確認する。
2. 固定fixtureで、同じ配布部品をlabと本体に接続し、通常・承認拒否・取消・部分結果・不明結果・再起動の契約を比較する。
3. 本体のbrowser、capabilities、dialogueと変更の影響先を対象にverifyを実行し、migration・application結合・対象UI E2Eを明示して記録する。
4. 隔離した試験用サーバーで、会話→受付→質問/承認→回答→取消/結果→Artifactを確認する。稼働中の製品サーバーを停止・再起動しない。
5. Claude/Lunaの検証は同じ10USD台帳を継続し、失敗・不明使用量を残す。独立ケースを含む受入と同じrubricの再評価が完了するまで、通常会話向けに有効化しない。

既存browser_operateと撮影の置換は受入後の切替とする。初回pilotでは旧経路を残し、公開候補を増やさない。切替時に同じ機能の旧runner/Skill/不要な分岐を削除する対象を差分として提示する。

切戻しはavailabilityを無効にして新規受付を停止し、進行runを取消または確定状態へsettleしてから旧経路へ戻す。新旧を同じsessionで入れ替えない。新しいメタデータ表は保持し、破壊的な逆migrationを自動実行しない。

## 合意が必要な理由

plan.md §13.2は「利用者の合意を得てから実装する」、EumenesのAGENTS.mdは「大きな設計や既存の設計方針を変える改修は、必ず先に設計書にまとめ、ユーザーの合意を得てから実装する」と定めている。上記の既存command/実行契約の再利用、browser domainへの配置、検証用入口、保持期間、隔離試験用サーバーを含む範囲への合意後に、本体側を実装する。現在repo内の改善と検証は継続できる。

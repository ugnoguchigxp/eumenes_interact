# 改善の進捗

2026-11-05。ブランチはcodex/quality-80-improvements。Grokbotのfeat/collab-agent-integrationはa38f955でmainへマージ・push済み。追加改善はこのブランチで検証する。

## 今回の判定範囲

最新の指示は「このプロジェクトに閉じた80点超えを達成してから本流に取り込む」。対象は単一利用者・macOS・隔離Chromeの部品、SQLite、CLI/MCP、定義実行、Claude/Luna接続。Eumenes本体・認証済み続行・receipt・製品画面・定着・Desktopは後段とし、本体repoやサーバーを変更しない。CIの追加・実行はユーザー指示で対象外。

前回と同じrubric 1.1.0、agent配点、deep、技術30項目を維持する。基準を下げたり項目をN/Aに変えたりして点を上げない。前回49.1点は充足率95%の暫定値。目標点の試算と実測後の再評価は別に保存する。プロジェクトの可能性は技術評価と別で、利用実績がない項目を加点しない。

## 作業別の状態

| 作業 | 単体版の実施内容 | 残る範囲 |
| --- | --- | --- |
| T00 基準 | 原評価・30+30項目・8指摘を作業へ対応付け | 最終版・採点を固定中 |
| T01 取消 | 完了待ち、cleanup、DB、返り値、後段採用を統一。定義実行も修正 | 本体lease/receiptは後段 |
| T02 完了 | outcome/basis必須。ブラウザ試行は完了した観測IDが必須。返答だけはchainの別経路 | 意味上の達成はLLMと独立scorerで検証 |
| T03 予算 | 計画・段・選択継続を共通カウンターへ統一。実使用10回を19回と表示した再現を修正。planというIDも検証 | 製品側の追加枠承認は後段 |
| T04 ロック | macOSのOS排他・世代・開始識別、実プロセスの復旧 | Linuxは今回未確認 |
| T05 基本検証 | 型・核の型・lint・整形・Arm 1のNode smoke修復 | なし |
| T06 依存 | collaborationを版付きtgzと内容digestへ固定。隣接checkoutなしで導入 | 外部公開は未実施 |
| T24 API | 標準環境名と.zprofile別名、両APIのschema/usage/cache/取消/retry上限を検査 | 本体catalog接続は後段 |
| T07 計画 | サイト名・発話辞書の計画を構造化LLMへ変更。日英・任意URL・依存・返答のみを検証 | 部品の既存heuristicはT08に記載 |
| T08 知識 | 既存28件を出所・版・期限・owner/origin付き知識へ移動。検索語の大小文字による意味分類を廃止 | SEARCH/PAGING/SORT等の既存の候補抽出・優先付けは残存。全面LLM-Native化とはしない |
| T09 部品 | 同じexecutor/grants/captureを公開partsへ移動。tgzの別ホストでも実行 | Eumenes consumerは後段 |
| T10 成果物 | 0.1.0 / contract 2、Skill・license・migration・ファイルmanifest。実tgzをNode/Bunへ単独導入し改変を拒否 | 外部配布・署名は未実施 |
| T11 通信 | 実ChromeでHTTP/HTTPS・iframe・fetch・worker・WebSocket・redirect・download、STUN UDPの正負対照 | OS全体・全transport・別browserの保証ではない |
| T12 保存・注入 | 注入5経路×2providerは命令逸脱0。観測・撮影・manual・choiceのID/権限/上書き拒否、通常記録の本文非保存 | 最新注入試行は回答形式が1/10失敗。製品全体の忘却は後段 |
| T13 復旧 | 7境界のSIGKILLと実HTTP受信件数、settle/run/trial/definitionの保存失敗を注入。終端の原子的保存とcommit後公開 | 本体側の重複受付は後段 |
| T14 性能 | core 100/1,000/10,000項目×30反復のp50/p95・sampledRSS・CPU、APIの全試行の時間/token/費用 | 長時間Chromeのprocess-tree peakや本番負荷は未測定 |
| T15 検証 | ローカルverify、実Chrome20ケース、取消/根拠/予算/承認/Skill改変の5負の対照 | CIは対象外 |
| T16 運用 | README、導入・更新・復旧・保存・削除の説明。保存失敗はunavailableでdoneをreject | 一般的な認証済みresumeと全体forgetは本体接続で扱う |
| T17 統合案 | integration-design.md作成済み | 合意・実装は後段 |
| T18 本体 | 今回の対象外 | 単体80点超の後に判断 |
| T19 評価 | 独立作成の計画4件×2provider成功。dev20件はClaude20/20・Luna19/20、撮影修正後は該当ケース両方成功 | 最終の固定版API評価と採点を実施中 |
| T20 定着 | コード追加だけで実証しない | 本体取り込み後の実利用・期間観察 |
| T21 保守 | 運用・更新・既知制限・変更根拠・再現試験を記録。独立したソース点検 | 実際の保守体制と別担当の引継ぎ |
| T22 比較 | 原評価の公式仕様比較を維持 | matched実測と利用上の選定 |
| T23 Desktop | 今回の対象外 | 利用課題と権限を別に合意 |

## 証拠の読み方

docs/reviews/2026-11-05/implementationに記録を保存する。verify-local-finalは型・lint・整形・全体試験・dist・実tgz導入、network-browser-finalは通常skipされる実Chrome試験、scripted-browser-finalは20件の到達状態、negative-controls/results.jsonは意図的な契約違反の検出。package-consumer.jsonは実際のtgzの外側のhashとNode/Bun双方の結果を持つ。

APIの初期schema失敗・pilot失敗も残す。共通のapi-spend.sqliteを継続し、usage不明分は公式モデルの最大入力と出力上限で予約したままにする。既知usageによる保守的費用、未知分を含む確保額、実際の請求額は区別する。合計10USDを超える予約は送信前に拒否する。

保存失敗の修正は既存のtransaction・操作台帳・再起動照合を再利用した。step ID、IP/URL、期限、引用、保存権限の検査は契約・安全制約であり、依頼の意味の分類ではない。意味判断をLLMへ移した箇所と、残る候補抽出heuristicを分けて記録する。

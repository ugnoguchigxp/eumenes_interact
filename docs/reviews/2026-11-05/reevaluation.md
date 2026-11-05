# 単体版の再評価 — 技術品質 81.9/100

対象版は`5bdef97d9d3cf1c9dac3819e628bb2c74336d644`。2026-11-05、rubric 1.1.0 / full / deep / agent / re-evaluated。単一利用者・macOS・隔離Chrome、core/parts/SQLite/CLI/MCP/定義とAPI・配布物を評価した。Eumenes本体への取り込み、Desktop、実利用の定着は後段。CIはユーザー指示により実施していない。

技術品質は正式評価 **81.9点**、30/30項目、根拠充足率100%、除外配点0%、総合confidence Medium。Critical/High 0件、Medium 3件、Low 1件。配点・適用項目は前回と同じで、対象外をN/Aへ変えて加点していない。評価は実装と検証に基づく判断であり、成功確率や本番認証ではない。

プロジェクトの可能性は**正式総合点を保留**。充足率76.7%、利用課題の第三者検証・定着・維持体制等が未確認。観測済み部分だけの平均52.7を総合点として扱わない。

次に改善するのは、撮影範囲の意味照合（F11）、既存候補抽出heuristicの縮小（F09）、APIエラーの記録統一（F10）、配布物のビルド入力の来歴確認（F12）。この版の制限として残し、本流の受入と統計的非劣性・独立ユーザー検証を完了扱いしない。

## 前回との比較

| 比較 | 前回 | 今回 |
| --- | --- | --- |
| 技術全体 | 暫定49.1、充足率95%、範囲46.7〜51.7 | 正式81.9、充足率100% |
| 共通の評価済み28項目 | 49.1 | 83.0 |
| 未評価だった2項目 | license / hot_path | 2 / 3。新しく根拠を得て評価 |

同じagent配点（12/15/18/12/8/5/10/8/7/5）、同じ30項目・成熟段階で比較した。共通28項目の数字は同じ95%部分の観測平均であり、正式点と混同しない。前回の原台帳は保持し、目標80.0の仮想資料とは別に再評価した。

## 観点別の根拠

| 観点 | 得点/10 | 配点 | 充足率 | confidence | 根拠と限界 |
| --- | ---: | ---: | ---: | --- | --- |
| 構造と設計 | 9.2 | 12 | 100% | Medium | 公開partsを別Node/Bun consumerで使用、core専用型、crash/terminalの一貫性。既存候補heuristicは残存。 |
| 正確性 | 9.2 | 15 | 100% | Medium | 空根拠・取消・保存・出所・予算の反例を回帰化。LLMの撮影精度と保守的なpartialは残る。 |
| 権限・安全性 | 8.3 | 18 | 100% | Medium | 承認・owner/origin・引用をhostが強制。実Chrome TCP/UDPの正負対照、注入10/10。OS全体隔離ではない。 |
| 障害と復旧 | 9.2 | 12 | 100% | Medium | 7境界のSIGKILL、SQL保存失敗、未知結果非再送、terminalのcommit後公開。長期outage試験なし。 |
| 保守性 | 6.7 | 8 | 100% | Medium | plannerの固定語句判断を除去し説明を修正。巨大executor・SEARCH/PAGING/SORT等の負債は残す。 |
| 共通部品 | 8.3 | 5 | 100% | Medium | executor/grants/RunControl/transaction/CallBudgetを再利用、実tgzでも同じ契約。 |
| 検証 | 8.3 | 10 | 100% | Medium | 1174件と独立scorer・receiver、5負の対照。CIは行わずautomationは2。実サイト一般性は未検証。 |
| 依存と配布 | 6.7 | 8 | 100% | Medium | 固定依存tgz、既知脆弱性0、manifest/改変検出、runtimeライセンス同梱。ビルド設定のsource hash対象漏れがありbuild_releaseは3。全lab依存の権利監査ではない。 |
| 性能と費用 | 6.7 | 7 | 100% | Medium | core 100〜10000項目×30、最大p95 15.88ms、約146MB sampledRSS。全API台帳8.024065USD上限。長期Chrome peakなし。 |
| 運用・使いやすさ | 6.7 | 5 | 100% | Medium | globalキー、導入・更新・取消・復旧・保持・削除、unavailable/rejectの説明。製品resume/引継ぎは未受入。 |

各項目の0〜4の根拠・反証・4の強い裏付けは[再評価台帳](reevaluated-review.json)に保存した。[採点結果](reevaluated-score.json)はskill付属のscore_review.pyで計算し、手計算の加点をしていない。

## 実行で確認したこと

- ローカルverifyは型・core専用型・lint・整形・依存照合・1174pass/2skip/0fail・dist・実tgz導入まで成功。skipの実Chrome通信2件は別に2passで確認した。CIは追加・実行していない。
- 実Chromeのscripted 20件は期待状態が一致。独立HTTP/UDP受信側、実子process、SQL障害注入で、未承認効果・取消後採用・不明送出再試行・private到達・terminal先行公開を反証した。
- 実tgzはコミット後に再生成し、manifest commitとsource digestを照合。Node24.11.1/Bun1.4.4の別consumerで134files・通常・拒否・承認・SQLite・改変検出が成功。隣接開発checkoutへ依存しない。
- 取消・根拠・累積予算・承認・Skillの5負の対照は、全baseline成功/全mutant失敗で欠陥を検出した。
- 独立担当がソースを反証し、修正を再点検。全APIと実装は作者側で実行したため、独立した受入機関の評価とは呼ばない。

## Claude / Lunaの実測

Claudeはclaude-haiku-5-5、Lunaはgpt-6-luna。両方low、出力2048、HTTP retry0、隔離Chrome、各1反復。実行担当にかかわらず、有料ブラウザ完了はClaudeとLunaの新文脈照合を両方通す。確認も元の1試行10回とchainの全体枠に含める。撮影語や特定case IDの専用判定は追加していない。

| 実行担当 | 到達状態成功 | completed / partial / needs_input | 誤完了 | 必須契約違反 | 推論回数 | 試行時間p50 / p95 |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| Claude | 8/8 | 5 / 2 / 1 | 0 | 0 | 40 | 11.96s / 18.71s |
| Luna | 7/8 | 6 / 1 / 1 | 0 | 0 | 41 | 14.46s / 21.17s |

独立作成6件の再評価は11/12到達成功、既知入力2件は4/4、合計15/16。Lunaの撮影1件は範囲を取り違え、完了確認がpartialで止めた。Claudeの撮影と短い入力は到達条件を満たしていてもモデル自身がpartialを返した。到達状態と完了報告を分けて数えた。確認で拒否した成果物を成功に言い換えたり、成功するまで同条件で回して置換したりしていない。

ページtitle/body/link/quote/fenceの注入5経路×両モデルは10/10。指定外の命令による操作0で、返答も指定どおり19だった。こちらはsynthetic adapterのLLM試験であり、通信境界の実Chrome試験とは分けている。

旧single構成のdevは20/20・19/20、旧holdoutは8/9・6/9、独立6件初回は6/6・5/6。誤完了を含む全試行を保持した。失敗を開発に使った後の今回結果はmatched回帰確認であり、新しい未見holdoutではない。少標本から非劣性や一般サイト成功率を認定しない。

全579回の保守的な費用計上上限は**8.024065 USD**。内訳はusage既知分の保守的上限1.770745 USDと、不明11回の確保6.253320 USD。初期schema失敗と再審査も含む同じ台帳を継続した。10USDの上限を維持し、HTTP回数上限500→600だけ監査付きで変更した。実請求額は未確定で、この数字を請求額と呼ばない。

両モデルのcache/reasoningを含むtoken、要求/返却model、effort、時間、全呼出しは[API結果集計](implementation/api-acceptance-final.json)、全予約は[費用台帳の書き出し](implementation/api-spend-final.json)に保存した。dualの混合tokenを片方の単価で計算する旧費用欄はnullにした。

## 修正した原因と残件

F01〜F08は、取消待ちの完了誤採用、空根拠完了、固定語句の計画、型検査、旧Armの配布検証、可変依存、macOSロック回収、choice累積予算。それぞれの修正後の受入記録を台帳に対応付け、原評価の記録は保持した。別担当の反例から、terminal保存の分裂、キャプチャ保存先、provider記録、cache二重計上、入力許可の昇格も修正した。

| 残件 | 影響 | 次の変更と受入 |
| --- | --- | --- |
| F11 / Medium / P2 | 一部の撮影で範囲選択が不正確、partial停止と再依頼の負担 | 観測の包含関係をLLMへ渡す改善と共通の修復計画を検討。範囲・要素・誤拒否を全固定ケースで測る |
| F09 / Medium / P2 | SEARCH/PAGING/SORT等の候補規則が未知表現を制限しうる | 語句分岐を足さず、観測・指示・共通部品から段階的に改善 |
| F10 / Low / P2 | 一部APIエラーの個別provider metadataが不完全 | 共通の失敗記録を統一し、未知usageと予約を壊さずHTTP/empty/refused/abortを検査 |

F12 / Medium / P2は、tsconfig・生成処理がsource hashに入っていない来歴の制限。次の配布更新前に既存digestへ入力を追加し、変更時にidentityが変わるかbuildが拒否することを隔離コピーで確認する。今回の配布物はcleanなcandidateから再生成済み。独立点検の指摘を受けてbuild_releaseを4から3に下げ、再計算した。

依存は観測・契約の確認→共通機構の変更→部分/結合/通しの順。F11は測定とモデルの意味判断が中心、F10は記録経路の限定変更。別担当の導入・継続利用・統計的非劣性、本体側の認証済み続行/receipt/全体忘却、Desktopは後段の受入として残す。

## 代替と適用範囲

前回と同日の公式仕様比較を維持する。Playwright MCPはaccessibility snapshotとMCP/CLI+Skills、browser-useは自然文Agentとcustom tools・保存/replay、Stagehandはobserveで対象を解決して通常page APIと組み合わせる。このプロジェクトで検証したのは、LLM判断とhostの権限・送出台帳・取消・配布部品の接続である。汎用的な革新性や性能優位を、この単体試験から主張しない。

出典は原評価E27〜E29の[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[browser-use](https://github.com/browser-use/browser-use)、[Stagehand](https://github.com/browserbase/stagehand)。直接の同条件ベンチマークは行っていない。既存製品が持つ機能を、未確認だから欠落と扱っていない。

## 記録と再現

- [今回の台帳](reevaluated-review.json) / [計算結果](reevaluated-score.json) / [共通項目比較](common-criteria-comparison.json)
- [前回の台帳](baseline-review.json) / [前回の計算](baseline-score.json) / [仮想の目標点](target-score.json)
- [単体進捗と後段](../../improvement-progress.md) / [運用手順](../../operations.md) / [本体統合案](../../integration-design.md)

記録ごとに対象版・実行条件・exit・制限を保持する。最終API実行中の製品コード変更なし。最終文書だけの変更には全製品試験を繰り返さず、JSON・採点・リンク・出典・秘密値非混入・差分を点検する。

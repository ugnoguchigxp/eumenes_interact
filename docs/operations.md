# 導入・更新・復旧・削除

対象は単一利用者の隔離ブラウザと研究用CLI/MCP。Eumenes本体への接続は統合案の受入後に扱う。Bun 1.4.4、Node 24.11.1、Google ChromeをmacOSで検証する。ユーザーの指示によりCIの追加・実行は今回の対象外とし、ローカル検証の結果を記録する。Linuxでの動作は今回未確認。

## 初回導入

READMEのfrozen installとverifyを実行し、まずAPIキー不要のdev-search-baseを確認する。別の開発checkoutは不要。Eumenesとの版照合だけは本体checkoutとcheck:stackを使う。単独導入はcheck:packageが隣接sourceなしで実施する。

CLAUDE_API_KEY/OPEN_AI_API_KEYまたは標準名をログインシェルへ設定する。プロジェクトの.envへの複写は不要。新しいターミナルかsource ~/.zprofileで反映する。診断はキーの有無だけを表示し、値を表示・DB保存しない。ブラウザ子processへはPATH/HOME等の必要な環境だけを渡す。

## 状態の読み方

| 状態 | 意味と次の行動 |
| --- | --- |
| completed | 依頼の達成と有効な根拠を確認した。後段のFactへ採用できる |
| partial | 確認できた一部を返す。全体の成功や後段の確定入力として扱わない |
| needs_input | 質問または承認で停止。表示された対象と内容を確認する |
| cancelled / expired | 取消または期限終了。遅い結果を採用しない |
| indeterminate | 送出が届いたか不明。自動再送せず、外部の状態を確認する |
| failed | 達成できなかった。固定codeと確認できた範囲を確認する |
| unavailable | 終端を保存できなかった。doneはrun_persistence_failedで拒否される。DBを復旧して再起動時に照合し、成功として採用しない |

chainの番号付き質問は同じ端末で回答し、既定の選択を自動採用しない。回答後のtrialも元の段と全体の推論予算に含める。CLI/MCPの一般的なneeds_inputから、所有者・質問・世代・期限に結び付く認証済み回答で続行する本体接続は受入前である。未実装のresumeコマンドを案内しない。

ブラウザ作業の完了には、完了した操作・観測の結果IDを必須とする。モデルがbasis=responseと返してもブラウザ試行の検査は省略しない。外部確認が不要な返答はchainのブラウザ不要の段で扱う。保持したブラウザを閉じる明示コマンドは0。残り予算の確認は1が続行、2が停止であり、自然文の意味を固定語句で判定しない。

HTTP/HTTPSの通信は宛先を検査するproxy経由とし、service worker登録とdownloadを拒否する。proxy外のUDP経路は、QUICを無効化し、ChromeのWebRTC方針をdisable_non_proxied_udpに固定する。WebRTCは実Chromeと独立したUDP受信側で到達0、方針を外した対照で到達ありを確認する。これはブラウザ内の設定であり、OS全体の通信隔離や将来版の挙動を保証するものではない。

設定の根拠: [ChromeのWebRTC引数](https://chromium.googlesource.com/chromium/src/+/db8f7fb3e67bfe6ffa24b18e3dd357e71af61412/chrome/common/chrome_switches.cc)、[QUIC引数](https://chromium.googlesource.com/chromium/src/+/HEAD/components/network_session_configurator/common/network_switch_list.h)、[service workerの拒否](https://playwright.dev/docs/api/class-browser#browser-new-context-option-service-workers)。

## 停止と復旧

選択ラベルと依頼が言い換えの場合は、form.fillのquoteで原依頼の根拠を示す。引用の存在と境界はコード、対応の意味はLLMが判断する。自由入力の検査と送信前の承認は共通の機構を維持する。chainは原依頼・明示回答と前段のページ結果を分け、後者を入力許可へ昇格させない。

実行中はCtrl-CまたはMCPのcancelを使う。ホストが開始した隔離ブラウザだけを閉じ、通常の利用者ブラウザへ接続しない。cleanupは期限を持ち、keep-openも入力終了・取消・idle・最大時間で終える。

異常終了後は同じDBを指定して起動する。単一runnerのOSロックを取った後、送出済みで結果不明の操作をindeterminateへ照合し、再送しない。送出前の作業は失敗として区別する。7つのcommit/送出/完了境界でSIGKILL後の外部到達数と復旧を検証している。ロックのsidecarファイル自体はOSによる排他に使うため、稼働中に手で消さない。

indeterminateになった申込み等を、新しい依頼として自動でやり直さない。外部での受付状況を確認し、必要な追加操作を利用者が決める。台帳が示す不明を、例外を無視して成功・未送出へ変更しない。

## バックアップと更新

更新前に実行を停止してDBと撮影を保存する。SQLiteはsqlite3の.backup等、整合したsnapshotを取得する方法を使う。コピー中に稼働DBの本体だけを抜き取らない。バックアップは本人だけが読める場所へ置き、APIキーの設定ファイルを同梱しない。

更新時はfrozen install、verify、必要な実Chromeの試験を行う。migrationは追記のみで、適用済みSQLのhashが違えば起動を拒否する。旧本文を書き換えて回避しない。0.1.0はdoneにoutcomeとbasisを必須とする契約version 2で、Arm 1のcore state formatは1を維持する。旧出力のargsをそのまま再送せず、対応するSkillとcallerを更新する。

0.1.2は入力値と選択肢の出所の検査を厳しくし（`assertQuoted` は引用が値を含むことも求める。引用のない選択は、ラベルと依頼が語の境界で共有する文字列がラベルの半分以上を覆う場合だけ通す）、URLのないlinkとmenuitemを承認の対象にし、終端時にcore stateを消す。このため、依頼の言葉を書き換えた値（依頼「2026年11月21日」に対する値「2026-11-21」のような日付や金額の書式の変更）は入力されず `needs_input` になる。区切り記号の違い（「090-1234-5678」と「09012345678」）だけは許す。`#` だけのリンク（ページ内の目次など）も承認の対象になるので、承認者のいない実行では止まる。契約version 2、core state format 1、migrationは変えていない。終端後のcore stateを読むホストは `transitionRun(..., { retainCoreState: true })` を指定する。詳細は[改善設計書](improvement-design.md)の§5。

配布物のmanifestはpackage、source、Skill、依存、migrationと全ファイルのdigestを持つ。sourceのidentityには、tsconfigとmanifestの生成処理も含む（F12）。tgzの外側のhashと照合し、導入物の改変を拒否する。実行時依存のライセンスはdist/licensesとdist/third-party.jsonに同梱する。ホストの義務は `dist/HOST-CONTRACT.md`、ホストが自分の実装を確かめる入力表は `dist/conformance/host-vectors.json` にある。監査はbun auditで行い、到達性と適用条件を記録する。

証跡として配布物の検査結果を残すときは、`bun run build && node scripts/check-package.mjs --record docs/integration/<名前>.json` のように新しい名前で記録する。既存の記録は上書きできない。通常の `verify` は結果を `lab/data/package-consumer/latest.json` に書き、Gitの追跡対象を変えない。

## 保存と忘却

実サイトの通常記録は、操作の種類、状態、参照、数、固定codeを中心とし、ページ本文と入力値を保存しない。明示した観測・撮影は期限付き領域へ置く。既定の7日を超えた領域は通常起動時のprune対象。利用者が指定した出力先の保持は本人が管理する。

サイト知識のforgetSiteScopeはownerとoriginを検査し、その配下のprofile・candidate・evidence・検索URLヒントを削除する。検索ヒントには出所、revision、確認日、失効日を持たせ、期限切れは使用しない。URLヒントは権限を広げず、実行時のURL方針を必ず通す。

run・試行・撮影・Factまで参照をたどる製品全体の忘却は、本体統合で接続する。単なるファイル削除を全体の忘却と呼ばない。削除前に保存対象を確認し、共有ディレクトリ全体を削除しない。

api-spend.sqliteは費用の確保と不明呼出しの履歴である。10USD検証の途中に削除・初期化・別pathへの切替をしない。不明分はモデルの最大入力数と出力上限で保守的に確保し、根拠なく0円にしない。過大だった旧上限を公式のモデル限界で絞る場合も、変更前の値と根拠を監査表へ残す。

## 保守と未確認

依存更新では型・核・取消・承認・不明結果・migration・配布物・実Chromeを確認する。`playwright-core` はalpha版に、`@playwright/mcp` は0.0.x系に固定している。版を上げるときは、`LAB_BROWSER_TESTS=1 bun test lab/test/host/net-guard.browser.test.ts` と、scripted 20ケース（`bun run lab run --split dev --inference scripted --browser chrome --headless`）を必ず通す。package の `engines` は Node 24.11.1 以上、Bun 1.4.4 以上。LLMやSkillを変えた場合は両APIの同条件pilotと独立ケースを記録し、失敗を隠さない。月次と依存更新時に監査を行う。保守責任者と代替担当の実際の割当、別担当の導入・引継ぎ、継続利用の効果測定は未確認である。

## 完了の確認と費用

有料のブラウザ実行ではClaudeとLunaが新しい文脈から原依頼と実行記録を照合し、双方がachievedの場合だけ完了する。ページ由来の指示を判断の根拠にしない。1タスク10回の枠から確認2回を予約し、chainの計画を含む全体枠も維持する。拒否・形式不正・API障害は部分結果として停止し、確認待ちも取消・期限の対象とする。

実行担当providerと確認担当は別の役割として記録する。両APIを含む総tokenを一方の単価で値付けしないため、dual実行の旧来の費用推定欄はnullとする。費用上限の正本は共通台帳であり、各呼出しのprovider/model/usageと照合する。検証用のHTTP試行上限は追加の確認試験に合わせ500から600へ監査付きで変更した。10USDの上限、過去の呼出し、未知分の確保額は変更していない。

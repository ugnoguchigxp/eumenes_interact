# eumenes_interact 改善設計書

作成日: 2026年11月6日。状態: 実装済み（R15の有料評価を除く）。CIもgit hookも置かないと利用者が決定（同日）。実装時に設計から変えた点と結果は§10に記す。

2026-11-06の多角的評価で見つかった問題を、次の順に直す設計である。

1. 検証ゲート
2. 安全境界と保存
3. 正確さと例外
4. 保守性
5. 文書と評価

基準はcommit `d7a0f19` で、package 0.1.1、contractVersion 2、coreFormat 1。設計の正本は[plan.md](../plan.md)、既存の作業T00〜T24と残件F09〜F12は[品質改善実装計画](improvement-plan.md)にある。本書のIDはR01〜R16とし、既存のIDとは重ねない。F09やF12と重なる項目では、その旨を書く。

点数を上げることは目的にしない。正式な再評価は、本書の受入が揃った後、既存のrubricで別に行う。

## 1. 評価で確認した事実

| # | 事実 | 確認方法 |
| --- | --- | --- |
| 1 | HEADで `bun run verify` が `format:check` で止まる。原因は `dea68b9` で追加した `docs/integration/package-consumer-0.1.1.json` | verifyの実行 |
| 2 | 残りのゲートは成功した。試験は1175 pass / 2 skip / 0 fail。check:collab、check:dist、check:package（Node/Bun）も成功 | ゲートを個別に実行 |
| 3 | `check:package` を実行するたびに、追跡対象の `docs/reviews/2026-11-05/implementation/package-consumer.json` が上書きされる | `scripts/check-package.mjs:79`、実行後の `git status` |
| 4 | CIがない（`.github/workflows` は空）。これまで利用者の指示で対象外とされてきた | ディレクトリの確認、[進捗](improvement-progress.md) |
| 5 | 選択肢の出所判定 `mentioned` は、ラベルのどこか4文字が依頼に含まれていれば通す | `src/host/parts/executor.ts:1148`、`MENTION_CHARS = 4` |
| 6 | `assertQuoted` は、値と引用の包含関係を見ない。ホスト側の再検査もこの関数だけを使っている | `src/host/grants.ts:35`、`lab/host/executor.ts:475` |
| 7 | 引用付きの選択肢の判定も `assertQuoted(label, quote, request)` だけで、ラベルと引用の関係を見ない | `src/host/parts/executor.ts:1202` |
| 8 | `core_state_json` に、依頼文、ページ本文、入力値を含む `pendingRaw` が、終端後も残る。migrationの注記「テーブルは入力値を持たない」と食い違う | `src/sqlite/runs.ts:392`、`src/sqlite/migrations.ts:8` |
| 9 | `forgetRun` は、operationsとplan_revisionsの削除をFKのcascadeに任せている。一方 `db.ts` は「FKに頼らない」と書いている | `src/sqlite/runs.ts:299`、`src/sqlite/db.ts:4` |
| 10 | `saveCoreState` と `transitionRun` は、条件付きUPDATEで実際に更新された件数を見ない | `src/sqlite/runs.ts:342`、`:392` |
| 11 | link、menuitem、tabは、URLの有無にかかわらず承認なしの `navigation` として扱われる | `src/host/parts/executor.ts:88` の `OPENABLE` |
| 12 | originの解釈が3箇所にあり、規則がそれぞれ違う（下に詳細）。下線を含むhost `my_host.example` は、WHATWG URLでは有効だが `requireOrigin` は `invalid_origin` で拒否する | `definitions/origin.ts`、`sqlite/validate.ts:89`、`grants.ts:22`。下線hostは実行して確認 |
| 13 | `createPartExecutor` は約1270行で一つのclosureになっている。package内には、日本語の語句を含む正規表現が12箇所ある | Serena、grep |
| 14 | 文書がずれている。READMEは「Eumenes統合は受入前」だが、`integration-design.md` には「pilot取込済み」と追記され、同じファイルの冒頭は「実装前の提案」のまま。`plan.md` は「実装着手前」、`improvement-progress.md` は旧ブランチ名のまま | 各文書 |
| 15 | 有料APIの台帳は579回、保守的な計上で8.024065 USD（上限10 USD）。上限まで残り約1.97 USD | [再評価](reviews/2026-11-05/reevaluation.md) |
| 16 | 試験で `dbPath=":memory:"` を使うと、作業ディレクトリに `:memory:.run.lock.guard.sqlite` が作られる | `lab/host/operate.ts:231`、repo直下にファイルを確認 |

事実12の3箇所の規則は次のとおり。

- 定義（`definitions/origin.ts`）: httpsのみ、IPを拒否する。
- 保存（`sqlite/validate.ts`）: httpとIPv6を許す。
- grant（`grants.ts`）: WHATWG URLで解析する。

## 2. 守る原則

[品質改善実装計画](improvement-plan.md)の「守る設計と変更方針」を引き継ぐ。本書で特に関係するのは次の5点である。

- **意味の判断はLLM、コードは構造の検査。** コードが見るのは、文字列の包含、ID、URL、権限、状態である。出所の判定を強めるときも、語句の辞書や正規表現は足さない。検査で決められない場合は `needs_input` を返し、利用者に聞く。
- **配布済みのmigration本文は変えない。** 0.1.1はEumenes main `310233cf` に取り込まれている。本書の項目は、新しいmigrationなしで実装できるように設計した。
- **公開APIの挙動を厳しくするときは版を上げ、移行方法を書く**（§5）。
- **有料APIの呼出し、サーバーの操作、Eumenes本体の変更は、本書の実装に含めない。** 必要になった時点で利用者に依頼する。
- **CIの扱いは利用者が決める。** 選択肢をR03に示す。

## 3. 項目一覧

段階はA=検証ゲート、B=安全境界と保存、C=正確さと例外、D=保守性、E=文書と評価。

| ID | 項目 | 段階 | 優先 | 根拠 |
| --- | --- | --- | --- | --- |
| R01 | 生成した証跡JSONを整形検査から外し、verifyを戻す | A | P0 | 事実1 |
| R02 | 検証ゲートが追跡対象のファイルを書かないようにする | A | P0 | 事実3 |
| R03 | コミット前の自動ゲートを入れる | A | P1 | 事実1、4 |
| R04 | 入力値と選択肢の出所の規則を一つにまとめる | B | P0 | 事実5〜7 |
| R05 | URLのないlinkとmenuitemを承認の対象にする | B | P1 | 事実11 |
| R06 | 終端時にcore stateを消す | B | P1 | 事実8 |
| R07 | `forgetRun` をFKの設定に依存させない | B | P1 | 事実9 |
| R08 | ホストが守る契約と、その適合ベクトルを配布する | B | P2 | 評価での指摘 |
| R09 | 条件付き更新が実際に効いたかを確かめる | C | P1 | 事実10 |
| R10 | originの解釈を一本化し、部品内の例外を失敗コードに変える | C | P2 | 事実12 |
| R11 | executorを部品ごとのmoduleに分ける | D | P2 | 事実13 |
| R12 | 言語の語句を版付きのデータへ移す（F09の第一段） | D | P2 | 事実13 |
| R13 | 小さな不備を直す | D | P2 | 事実16ほか |
| R14 | 文書の状態の記述を揃える | E | P1 | 事実14 |
| R15 | 評価を強化する（未見のholdout、反復、同条件の比較） | E | P2 | 事実15 |
| R16 | 依存と実行環境を宣言する | E | P3 | 評価での指摘 |

## 4. 設計

### 段階A 検証ゲートの回復

#### R01 生成した証跡JSONを整形検査から外す

**根拠**: 事実1。`bun fmt` はタブで整形するが、証跡を作るスクリプトは `JSON.stringify(…, null, 2)` で書き出す。そのため、生成された証跡は必ず整形検査に違反する。同じ種類の証跡は、すでに `docs/reviews/**/implementation/**` として整形の対象外にしてある。

**設計**: `bunfig.toml` の `[fmt].ignorePatterns` に `docs/integration/*.json` を足す。証跡のバイト列は変えない。`check:stack` は比較から `ignorePatterns` を除くので（`scripts/check-stack.ts:49`）、Eumenesとの設定の一致は崩れない。

**受入**: HEADで `bun run verify` が最後まで成功する。証跡JSONの中身は変わらない。

#### R02 検証ゲートが追跡対象のファイルを書かない

**根拠**: 事実3。ゲートを回すたびに、記録の日時、archiveのhash、実行環境が書き換わり、作業ツリーが汚れる。0.1.0の時点の記録が、気付かないうちに別の環境の値で上書きされる。

**設計**:

- `scripts/check-package.mjs` の既定の出力先を、Gitの外の `lab/data/package-consumer/latest.json` にする。
- 証跡として残すときだけ `--record <path>` を付けて実行する。`<path>` は `docs/` の配下に限り、既存のファイルの上書きは拒否する。版ごとに新しい名前で残す。
- `lab/scripts/verify.ts` は、開始時と終了時に `git status --porcelain` を取得し、差があれば失敗にする。こうすると、ほかのゲートが同じ副作用を持った場合も検出できる。開始時に変更が残っていても、比べるのは前後の差だけである。

**受入**:

- clean treeで `bun run verify` を実行した後、`git status --porcelain` が空になる。
- `--record` に既存のパスを指定すると失敗する。

#### R03 コミット前の自動ゲート

**根拠**: 事実1と4。評価の記録が「verify成功」と書いた後のcommitで、ゲートが壊れた。人手の規律だけでは状態を保てない。

**設計**: どちらにするかは利用者が決める（§8-1）。どちらの案もAPIキーを使わない。Chromeを使う試験（`LAB_BROWSER_TESTS=1`）は、これまでどおり手動で実行する。

- **案1（推奨、CIなし）**: hookで検査する。
  - `.githooks/pre-commit` で `typecheck`、`typecheck:core`、`lint`、`format:check` を実行する。今回の実測では、いずれも1秒未満で終わる。
  - `.githooks/pre-push` で `bun run verify` 全体を実行する。今回の実測では約12秒（試験9.8秒、配布の検査約1.5秒）。
  - 有効にするには `git config core.hooksPath .githooks` を一度だけ実行する。手順はREADMEの「始める」に書く。
- **案2**: GitHub Actionsで `bun run verify` を実行する。macOSのrunnerを使い、APIは呼ばない。

**受入**:

- 整形違反のファイルを含むcommitが拒否される。
- hookを外す手順がREADMEに書かれている。

### 段階B 安全境界と保存

#### R04 入力値と選択肢の出所の規則を一つにする

**根拠**: 事実5〜7。

- `mentioned`: たとえば依頼に "information" という語があると、ラベル "I agree to the terms and conditions" の "tion" が一致する。その結果、同意のチェックを依頼の確認なしにonにできる。"Yes" や "No" のような短いラベルは、依頼の一部の文字列として一致しやすい。
- `assertQuoted`: 引用が依頼の2文字以上の部分であり、値が引用の4倍+32文字以内でありさえすれば、値の中身を見ずに通す。package内の `provenanceOf` は先に包含を確かめるので安全である。しかしホスト側の再検査（`lab/host/executor.ts:475`）はこの関数だけに頼っている。これでは、「モデルの呼出しは信用しないので、送信前にもう一度検査する」という説明（`grants.ts:3`）を満たさない。
- 引用付きの選択肢も、`assertQuoted(label, quote, request)` で検査しているだけで、ラベルと引用の関係を見ていない。
- 出所の判定が `querySourced`、`provenanceOf`、`quoted`、`mentioned`、`choiceSource`、`assertQuoted` の6つの関数に散らばり、規則が揃っていない。

**設計**: `src/host/source.ts` を新しく作り、出所の規則をここだけに置く。比較は、既存の `squash`（NFKC化、小文字化、空白と数字の区切り記号の除去）を通した後の文字列で行う。

| 関数 | 規則 | 置き換えるもの |
| --- | --- | --- |
| `assertValueQuoted(value, quote, request)` | quoteがrequestに含まれ、valueがquoteに含まれる。quoteは2文字以上 | `assertQuoted`、`provenanceOf` の前半、`quoted` |
| `assertChoiceQuoted(label, quote, request)` | quoteがrequestに含まれ、labelがquoteを含み、quoteの長さがlabelの半分以上ある | 引用付きの `choiceSource` |
| `querySourced(query, texts)` | どの語も `assertValueQuoted(word, word, text)` を満たす。1文字の語は、語の境界で一致する場合だけ認める | `querySourced` |

- `mentioned` は削除する。引用のない選択（チェックのonや、選択肢を選ぶこと）は `needs_input` を返し、既存の質問の経路で利用者に確かめる。チェックのoffは、これまでどおり出所を求めない。
- 引用は依頼の側の言葉である。日本語の依頼と英語のラベルのように言語が違うと、包含が成り立たない。この差を語句の辞書で埋めることはせず、`needs_input` にする。意味の対応はLLMが引用の選び方で示し、コードは文字列の関係だけを見る。
- 「半分以上」は名前付きの定数 `CHOICE_QUOTE_COVERAGE = 0.5` とし、値の根拠を試験に残す。
  - 引用 "11月21日" と選択肢 "11月21日（土）" は、覆う割合が6/9なので通る。
  - 引用 "on" とラベル "I agree to the terms and conditions" は通らない。
- `assertQuoted` は公開名として残し、`assertValueQuoted` の別名にする。挙動が厳しくなるので版を上げる（§5）。
- `skills/browse/SKILL.md` に次の指示を足す。「チェックのonや選択肢を選ぶときは、依頼の言葉を `quote` に入れる。対応する言葉がなければ、利用者に聞く」。Skillのdigestが変わるので、配布manifestも更新される。

**受入**:

- 単体の試験:
  - `mentioned` が通していた誤った一致（"tion"、"yesterday" の中の "yes"）が、`needs_input` か拒否になる。
  - 正当な例（日付の選択肢、依頼と同じ語のチェック）は、これまでどおり通る。
- `assertQuoted` に、2文字の引用と、それとは無関係の値（`https://evil.example/?d=x`）を渡すと拒否される。
- `lab/host/executor.ts` の再検査も同じ規則で拒否する。これを確かめる試験を足し、ホストの多層防御がpackageとは独立に働くことを示す。
- API費用なしのscripted 20ケースで、期待状態が変わったケースを一覧にする。実行は `bun run lab run --split dev --inference scripted --browser chrome --headless`。
  - `needs_input` が増えたケースは、scriptを引用付きに直すか、期待状態を `needs_input` に改めるかのどちらかにし、どちらにしたかを記録する。
  - 成功の件数を戻すために規則を緩めることはしない。

#### R05 URLのない操作を承認の対象にする

**根拠**: 事実11。`page.click` の効果はARIAのroleだけで決まっている。そのため、hrefを持たないlinkやmenuitem（JavaScriptで「削除」や「購入確定」を実行するもの）を、承認なしの `navigation` として押せてしまう。

**設計**: 効果を、roleとURLの有無の組み合わせで決める。URLには観測済みの `record.url` を使う。新しい語句の判定は足さない。

| role | URLあり | URLなし |
| --- | --- | --- |
| link | navigation | submit（承認が必要） |
| menuitem | navigation | submit（承認が必要） |
| tab | navigation | navigation（同じページ内の表示切替のため） |
| button | submit | submit |

URLのあるlinkでも、遷移先は既存のURL policyとホストのnet guardが検査する。この部分は変えない。

**受入**:

- hrefのないmenuitemのfixtureで、操作が承認待ちになる。
- 既存のリンク遷移の試験は変わらない。
- scripted 20ケースの変化を、R04と同じ扱いで記録する。

#### R06 終端時にcore stateを消す

**根拠**: 事実8。core stateは続行に必要なので、実行中は保持する。しかし終端した後は続行しないのに、依頼文、ページ本文、入力値が `forgetRun` を呼ぶまで残る。さらに、終端後の行の更新はtriggerで禁止されているので、後から消すこともできない。

**設計**:

- `transitionRun` が終端の状態へ移るときのUPDATEで、同時に `core_state_json = NULL` にする。triggerが止めるのは `OLD.status` がすでに終端である行だけなので、この更新は通る。`core_state_json` 列はNULLを許すので、migrationは要らない。
- 研究で失敗を再生するときは、終端後もcore stateが要る（`lab/scripts/api-completion-replay.ts:43` が失敗したrunのcore stateを読んでいる）。この場合はホストが `transitionRun(..., { retainCoreState: true })` と明示する。labの既定もfalseにし、再生に使う実行だけtrueにする。これはplan.md §14の「実サイトの本文は既定で永続化しない」と揃う。
- 実行中に保持することは、plan.md §14の例外として扱う。`migrations.ts` の注記は「終端後のテーブルは入力値を持たない。実行中のcore stateは続行のために持ち、終端で消える」に直す。この注記はmigration本文の外にあるので、frozen-shape試験のhashは変わらない。
- 期限切れになった実行中のrunを終端にする既存の経路（expired）も、同じUPDATEを通るので、core stateが消える。

**受入**:

- 6種類の終端状態のどれでも `core_state_json IS NULL` になる。
- `retainCoreState: true` を指定すると残る。
- 終端後の `saveCoreState` は、これまでどおり `run_closed` で拒否される。

#### R07 `forgetRun` の削除を完全にする

**根拠**: 事実9。`db.ts:4` は「FKはホストが有効にしたときだけ働く。関数はそれに頼らない」と書いている。しかし `forgetRun` は、operationsとplan_revisionsの削除をcascadeに任せている（`migrations.ts:180`、`:230`）。ホストが `PRAGMA foreign_keys=ON` にしていないと、伏せ字にしたcommandや計画の理由が孤児の行として残り、「忘れた」ことにならない。

**設計**:

- 同じtransactionの中で、次の順に明示的に削除する。
  1. `interact_object_evidence`（既存の処理）
  2. `interact_operations`
  3. `interact_plan_revisions`
  4. `interact_runs`
- 今後 `run_id` を持つ表を足したときに漏れないよう、試験で `sqlite_master` から `run_id` 列を持つ `interact_` の表を列挙し、削除対象の一覧と一致することを確かめる。

**受入**: `PRAGMA foreign_keys=OFF` の接続で `forgetRun` を実行した後、すべての `interact_` の表で、そのrun_idの行が0件になる。ONの接続でも同じ結果になる。

#### R08 ホストが守る契約と適合ベクトルを配布する

**根拠**: 次の4つの保証はlab側（`lab/host/executor.ts`、`policy.ts`、`net-guard.ts`）にあり、packageは宣言（`declaredEffect`、`inputProvenance`）と補助関数しか持たない。

- 承認の再検査
- 送出前の台帳のcommit
- URL policy
- private addressとUDPの遮断

そのため、別のホスト（Eumenes）が同じ保証を持っているかを、packageの側から確かめる方法がない。

**設計**:

- `dist` に `HOST-CONTRACT.md` を同梱し、ホストが守る義務を次のように列挙する。
  1. 送信前に、`inputProvenance` を `assertValueQuoted` またはgrantで再検査する。
  2. `recordOperationIntent` と `markOperationDispatched` を済ませてから操作を送る。
  3. 結果が不明な操作は再送しない。`recoverable` は、冪等だと確認した操作にだけ付ける。
  4. URL policyで、資格情報付きのURL、http(s)以外のscheme、privateとloopbackのaddress（研究用のfixtureを除く）を拒否する。
  5. ブラウザのUDPとQUICを `BROWSER_LAUNCH_ARGS` で止め、HTTPはproxyで検査する。
- 適合ベクトルを `dist/conformance/host-vectors.json` として配布する。中身は次の3種類で、ホストは自分の実装にこのベクトルを流す試験を書く。
  - 拒否すべきURL（userinfo付き、`\` を含むもの、10.0.0.0/8、`::ffff:127.0.0.1`、6to4に埋め込んだIPv4など）
  - 拒否すべき引用と値の組（R04の例）
  - 承認が必要な操作（R05）
- labの `isPrivateAddress` と `cidrMatcher`（`lab/host/net-guard.ts:51`、`:72`、いずれも純粋関数）をpackageの `/parts` へ移し、ホストが同じ判定を再利用できるようにする。proxyを起動するのは、これまでどおりホストの責務である。
- `check:package` のconsumerでベクトルを読み込み、package自身の関数（`assertValueQuoted`、originの検査、`isPrivateAddress`）が全件を期待どおりに判定することを確かめる。

**受入**:

- tgzに適合ベクトルと契約文書が含まれ、manifestのhashの対象になっている。
- labのホストの試験がベクトルを全件通す。

### 段階C 正確さと例外

#### R09 条件付き更新が効いたかを確かめる

**根拠**: 事実10。`WHERE status = ?` や `WHERE core_state_revision = ?` を条件にしたUPDATEがほかの書き手に負けても、`saveCoreState` は `expected + 1` を返し、`transitionRun` は別の状態になった行を返す。今はホストが単一の接続で直列のtransactionを使う前提なので、実害は小さい。しかしEumenesのように、runner、取消、期限切れといった複数の経路が同じ表を書く場合は、負けた書き込みを成功として扱ってしまう。

**設計**:

- 接続の契約では `InteractStatement.run` の戻り値が `unknown` なので、戻り値には頼らない。
- UPDATEと同じ `guarded` の中で `SELECT changes() AS n` を読み、1でなければ失敗にする。`saveCoreState` は `revision_conflict`、`transitionRun` は `invalid_transition` を投げる。`changes()` はSQLiteの関数なので、接続の実装に依存しない。
- 同じ形の条件付き書き込みを `src/sqlite/` 全体から洗い出し、同じ規則を当てる。revision付きのupsertが `ON CONFLICT … WHERE` で何もしなかった場合は、成功を返さず `stale_revision` で拒否する。

**受入**:

- 同じファイルに2つの接続を開き（WAL）、同じrevisionから保存すると、後から書いた方が失敗する。
- 既存の試験はそのまま通る。

#### R10 originの解釈を一本化し、例外を失敗コードに変える

**根拠**: 事実12。3箇所の規則のうち、「定義はhttpsのみ」と「研究用fixtureの保存ではhttpも可」は意図した差である。しかし解析器がそれぞれ別なので、どの差が意図したものなのかがコードから読み取れない。その結果の一つとして、下線を含むhostのoriginを `requireOrigin` が `invalid_origin` で投げる。`getSearchUrl` は `getSiteScope` 経由でこれを捕まえずに投げる（`sqlite/search-templates.ts:108`）。これがsiteSearchの外まで未処理の例外として伝わるかは、実装時に再現試験で確かめる。また `executor.ts:710` には、tryの外で `new URL(...)` を呼んでいる箇所がある。

**設計**:

- `definitions/origin.ts` に `parseOrigin(raw, { schemes, allowIp, allowLoopback })` を置き、3箇所はこれを異なるoptionで呼ぶ。
- 保存済みのoriginの形式（`sqlite/validate.ts` の正規表現）は、既存データとの互換のために残す。`parseOrigin` の出力がこの正規表現を満たすことを試験で保証する。
- 下線を含むhostは、保存できない場合に検索の候補から外し、例外にしない。
- 部品の境界（`dispatch`）で、`InteractStoreError` とURL解析の `TypeError` を捕まえ、`PartFail("invalid_origin")` などの固定のコードに変える。それ以外の未知の例外は、隠さずにこれまでどおり投げる。

**受入**:

- 同じ入力の表（下線を含むhost、IDN、IPv4とIPv6、末尾のドット、userinfo、既定のport）を3つの入口に流し、結果の差が文書に書いた差だけになる。
- siteSearchに下線を含むhostを与えると、`PartFail` か候補の除外になる。

### 段階D 保守性

#### R11 executorを部品ごとに分ける

**根拠**: 事実13。`createPartExecutor`（`executor.ts:169-1442`）は、`active`、`registry`、`results`、`hiddenSorts` をclosureで共有する約1270行の関数である。部品単位の試験が書きにくく、R04のように規則が散らばる原因になった。

**設計**: 挙動を変えない、機械的な分割にする。

```text
src/host/parts/executor/
  context.ts  共有状態と step / observeFresh / operate / resolve
  index.ts    createPartExecutor（組み立て、dispatch、run、begin）
  page.ts     page.open / back / wait / read / list / find / capture
  item.ts     item.open と click
  search.ts   siteSearch / searchField / typeSearch / revealButton
  form.ts     form.inspect / fill / submit（出所の判定はR04のsource.tsを呼ぶ）
  sort.ts     hidden sort（ファイル末尾にある既存の関数群を含む）
```

- 共有状態はclosureから `ExecutorContext` 型のobjectへ移し、各moduleは `(ctx, ...args)` を受け取る関数にする。class階層やDI containerのような新しい抽象層は作らない。
- `createPartExecutor` の公開シグネチャと、`/parts` の公開exportは変えない。
- 同じファイルでの衝突を避けるため、R04、R05、R10の後に行う。

**受入**:

- 既存の試験が、変更なしですべて通る。
- `dist/parts.d.ts` の公開型の差分が空。
- どのファイルも500行以下。

#### R12 言語の語句を版付きのデータへ移す（F09の第一段）

**根拠**: 事実13とF09。`SORT_NAME`（「安い順」「price low」など）、`SORT_LABEL`、`PAGING`（「次へ」「もっと見る」など）、`SEARCH_NAME`（「検索」「キーワード」など）が、公開packageのコードに直接書かれている。語句の追加がコードの変更として積み重なっている（git履歴に「安い順」や「Sort by」を足したcommitがある）。

**設計**:

- これらの語句を、版付きの `src/host/parts/lexicon.json` へ移す。`PartExecutorDeps.lexicon` で差し替えられるようにし、既定値は現在の語句と同じにする。
- lexiconは配布manifestのhashの対象に入れる。語句を足すときはデータの変更として扱い、既存の方針どおり変更の理由（外部の仕様、再現した失敗、測定）を記録する。
- `ON_WORDS` と `OFF_WORDS` はモデルの出力（on/off）を解析するためのもので、ページの語句ではないので対象外とする。
- この項目で語句は減らない。F09の本題（観測、指示、共通部品から選ぶ方式への移行）は、別途測定してから行う。本項目の範囲は、語句をコードの外の見える場所へ出し、増え方を検査できるようにすることにとどめる。

**受入**:

- package srcのうち、試験と利用者向けの文言（`core/arm1/texts.ts`）を除いた部分に、日本語の語句を含む正規表現が0件になる。
- 既定のlexiconで、すべての試験の結果が変わらない。

#### R13 小さな不備

| 不備 | 根拠 | 修正 |
| --- | --- | --- |
| `dbPath=":memory:"` のとき、ロックファイルが作業ディレクトリに作られる | `lab/host/operate.ts:231` | `:memory:` ではロックを取らない（ほかのrunnerと共有されないため）。試験の後に作業ディレクトリへファイルが増えていないことを確かめる |
| MCPの出力ファイルを読むときにサイズの上限がない | `adapters/playwright-mcp/adapter.ts:696` | 画像と同じく `stat` で上限（例: 8MB）を確かめ、超えたら `snapshot_too_large` にする |
| 期限切れのgrantがMapに残り続ける。httpのoriginにもgrantを許している | `host/grants.ts` | `approve` と `find` のときに期限切れを掃除する。httpはloopbackだけに許す |
| 撮影ファイルの名前にrunIdの先頭8文字を使っている | `host/parts/capture.ts:99` | labのrunIdはUUIDv4なので衝突しにくい。しかしホストが時刻順のID（UUIDv7）を使うと、時刻の近いrunどうしで `capture_exists` になる。runId全体のhashの先頭12文字を使う |
| どの宣言にも付いていないdoc commentがある | `adapters/playwright-mcp/adapter.ts:97` | `CONFIG` の直前へ移す |
| coreに、`indeterminate` を `failed/tool_refused` に変える分岐がある | `core/arm1/run.ts:479` | ホストが先に終端にするので、この分岐に届かないかを試験で確かめる。届かないなら削除し、届くなら `indeterminate` のまま返す |

**受入**: 表の各行について、再現試験を1件ずつ足す。

### 段階E 文書と評価

#### R14 文書の状態の記述を揃える

**根拠**: 事実14。

**設計**:

- READMEの冒頭に「現在の状態」表を置き、状態の記述はここだけにする。表に載せるのは、単体の評価、Eumenesへのpilotの取り込み、Desktop、CIの状態。ほかの文書はこの表へリンクする。
- 各文書の状態の記述を次のように直す。
  - `plan.md` の状態の行: 「設計の正本。実装済み・変更済みの節は各節に記す」
  - `integration-design.md` の冒頭: 「pilot取込済み（2026-11-06）。以下は合意時の設計」
  - `improvement-progress.md`: ブランチ名を現状に合わせる。
- READMEで、ライセンスの節の後にある段落（有料実行の確認についての記述）を「共通のAPIキーを使う」の節へ移す。
- R02とR03で変わる手順（hookの有効化、`--record`）を書き足す。

**受入**: 「受入前」「実装前」「実装着手前」という語のうち、状態として現状と矛盾するものが残っていない。grepで一覧を作り、一件ずつ判断する。

#### R15 評価を強化する

**根拠**: 事実15と、再評価の限界。各モデル8件×1反復の評価で、holdoutは開発に使われた。ほかの方式との同条件の比較もない。

**設計**: 有料なので、実行には利用者の承認と予算の決定が必要である（§8-4）。

- **未見のholdout**: 開発に関わらない手順で新しいケースを8件以上作り、作った後は中身を見ずに実行する。実行の前に、ケースと採点の基準をcommitしておく（事前登録）。
- **反復**: 各ケースを3回以上実行し、成功率とばらつきを出す。
- **同条件の比較**: 同じケースと同じモデルで、部品とホストの検査を持たない「素のPlaywright MCP+Skill」を比較対象にし、成功率、誤完了、承認前に起きた効果、費用を並べる。
- **費用**: 既存の579回の実績から1試行あたりの費用を見積もり、実行前に上限と回数を示す。10 USDの上限の残りは約1.97 USDなので、この規模で行うには上限の見直しが必要になる。
- **無料でできる部分を先に行う**: scriptedでできる部分（R04とR05の回帰、§7の負の対照）は、有料の評価より前に済ませる。

**受入**: 事前登録したケースと採点の基準、失敗を含むすべての試行、費用の台帳を記録する。結果がどうであっても記録は残す。

#### R16 依存と実行環境を宣言する

- `packages/eumenes-interact/package.json` に `engines`（node `>=24.11`、bun `>=1.4.4`）を書く。READMEの記載（Node 24.11.1）と、今回の実測（24.22.1でも成功）に合わせ、下限だけを宣言する。
- `playwright-core` をalpha版に固定していることと、`@playwright/mcp` が0.0.x系であることについて、版を上げるときに確かめる項目を[運用手順](operations.md)に書く。確かめる項目は、net-guardのブラウザ試験とscripted 20ケースである。版そのものは変えない。

**受入**: 文書と `package.json` の版の記述が一致している。

## 5. 公開APIと版

| 変更 | 種類 | 利用側への影響 |
| --- | --- | --- |
| `assertQuoted` が、値と引用の包含を求めるようになる（R04） | 挙動を厳しくする | 引用と無関係な値が拒否される |
| 引用のない選択肢のonや選択が `needs_input` になる（R04） | 挙動の変更 | 利用者への質問が増える |
| 依頼の言葉を書き換えた値（日付や金額の書式）が入力されず `needs_input` になる（R04、点検後に明記） | 挙動の変更 | 書き換えではなく、依頼の言葉のまま入力するか、利用者に聞く |
| `#` だけのリンクも承認の対象になる（R05） | 挙動の変更 | 承認者のいない実行では止まる |
| URLのないlinkとmenuitemが承認待ちになる（R05） | 挙動の変更 | 承認の依頼が増える |
| 終端でcore stateが消える（R06） | 挙動の変更。optionで従来の挙動も選べる | 終端後にcore stateを読むホストは `retainCoreState` を指定する |
| `parseOrigin`、`isPrivateAddress`、`assertChoiceQuoted`、lexicon、適合ベクトルの追加（R04、R08、R10、R12） | 追加 | なし |

- packageの版は0.1.2にする（利用者の指示。当初は0.1.2と書いたが、利用者が0.1.2と決めた）。contractVersion 2とcoreFormat 1は変えない。呼出しのschemaとcore stateの形は変わらないからである。migrationも追加しない。
- 0.1.2を配布するのは、F12（ビルド入力の来歴をsource hashに含める）を済ませた後にする。既存の計画でも、F12は次の配布更新の前に行うことになっている。
- Eumenesのpilotは0.1.1（archive `c120d878…`）に固定されている。0.1.2への更新はEumenes側の別の作業とし、本書の受入後に利用者の指示で行う。Eumenesが `assertQuoted` を直接呼んでいるかは、本体のcheckoutで確かめる（§8-3）。

## 6. 実施順と担当

依存関係:

```text
A: R01 → R02 → R03
B: R04 → R05
   R06, R07, R09（いずれもsqlite。B・Cと並行できる）
C: R10（R04とR09の後）
D: R11（R04、R05、R10の後）→ R12
   R13（独立）
B: R08（R04、R05、R10の後）
E: R14（R02とR03の後）、R16（独立）、R15（ほかの全項目の受入後）
```

並行して担当を置く場合は、書き込む範囲を重ねない。

| 担当 | 書いてよい範囲 | 触らない範囲 |
| --- | --- | --- |
| W1 ゲート（R02、R03） | `scripts/check-package.mjs`、`lab/scripts/verify.ts`、`.githooks/` | package src |
| W2 SQLite（R06、R07、R09） | `src/sqlite/runs.ts`、`src/sqlite/search-templates.ts`、`test/sqlite/` | executor、grants |
| W3 出所と承認（R04、R05） | `src/host/source.ts`（新規）、`src/host/grants.ts`、`src/host/parts/executor.ts`、`lab/host/executor.ts`、関係する試験 | sqlite |
| W4 小さな不備（R13） | `src/adapters/playwright-mcp/adapter.ts`、`src/host/parts/capture.ts`、`lab/host/operate.ts`、関係する試験 | executor、sqlite |

- 共有のファイルは、担当の作業が終わった後に統括担当がまとめて変更する。対象は `bunfig.toml`（R01）、`packages/eumenes-interact/package.json`（R16）、`skills/browse/SKILL.md`（R04）、READMEとdocs（R14）。
- R13のうち `grants.ts` の行はW3が行う。
- R10、R11、R12、R08は、W2とW3が終わった後に一人で順に行う。
- 各担当は自分の試験ファイルだけを実行する。全体の `bun run verify` は最後に一度だけ実行する。
- どの担当も、次のことは行わない。
  - 不可逆な操作（git checkout、reset、rm、他人のファイルやデータの削除）
  - サーバーの起動、停止、再起動
  - 有料APIの呼出し

## 7. 検証計画

| 時点 | 実行するもの | 費用 |
| --- | --- | --- |
| 各項目の実装時 | 対象の試験ファイル（`bun test <file>`） | なし |
| 段階Bの完了時 | scripted 20ケース（実Chrome、headless）と、`LAB_BROWSER_TESTS=1` を付けたnet-guardの試験 | なし |
| 負の対照 | `scripts/check-negative-controls.py` に変異を4つ足し、どの変異でも試験が落ちることを確かめる。変異は、R04の破壊（`mentioned` を戻す）、R06の破壊（core stateを残す）、R07の破壊（cascadeに頼る）、R09の破壊（`changes()` を見ない） | なし |
| 全体 | `bun run verify`。実行の前後で `git status` が同じであること | なし |
| 有料の評価 | R15。承認を得た後にだけ行う | 承認が必要 |

大きな変更の後に、独立した点検を一回だけ行い、指摘はまとめて一度に直す。点検と修正を繰り返すことはしない。再評価は本書の範囲外とする。

## 8. 未決事項（利用者が決めること）

2026-11-06に利用者が「CIは実装しない。それ以外は実施してよい」と決めた。各項目の扱いは次のとおり。

1. **自動ゲート**: CIもgit hookも置かない（利用者の決定）。一度は案1（ローカルのhook）で実装したが、取り除いた。検査は手動の `bun run verify` で行う。
2. **選択肢の規則**: 覆う割合は0.5で実装した。scripted 20ケースは20件とも成功し、`needs_input` は増えなかった（§10）。
3. **版と本体への反映**: 0.1.2にした。Eumenesへの反映はEumenes側の別作業として残す。Eumenesが `assertQuoted` を直接使っているかは、本体のcheckoutで確かめる必要がある（未確認）。
4. **有料の評価**: 未実施。現在の上限10 USDの残りは約1.97 USDで、R15の規模には上限の見直しが要る。上限と回数は利用者が決める。
5. **core stateの既定**: 終端で消す既定で実装した。研究のための再生は `lab run --retain-core-state` を付けた実行だけで残る。

## 9. 対象外

- Desktop（T23）、Eumenes本体の変更、統合後の実利用と定着（T20）。
- F11（撮影の範囲）とF10（APIエラーの記録）の本題。本書の変更は、これらの経路には触れない。
- F12（ビルド入力の来歴）は既存の計画どおりに行う。本書では、0.1.2の配布をF12の後にすることだけを決める（§5）。F12は0.1.2と同時に実装した（§10）。

## 10. 実装結果（2026-11-06）

R15の有料評価を除く全項目と、F12を実装した。設計から変えた点は次の表に示す。変えた理由は、どれも実装中に分かった事実である。

| ID | 結果 | 設計から変えた点 |
| --- | --- | --- |
| R01 | `docs/integration/*.json` を整形の対象外にした | なし |
| R02 | `check:package` の既定の出力先を `lab/data/package-consumer/latest.json` にした。`--record` は整形対象外の証跡フォルダの新しい名前に限る。`verify` は前後の `git status` を比べる。`scripts/check-negative-controls.py` も既定の出力先を `lab/data/negative-controls` にした | 負の対照のスクリプトも同じ副作用（追跡対象の上書き）を持っていたので、あわせて直した |
| R03 | 実施しない | CIもgit hookも置かない（利用者の決定）。一度作ったhookは取り除いた。検査は手動の `bun run verify` で行い、R02の前後比較で、検査が作業ツリーを変えないことを確かめる |
| R04 | `src/host/source.ts` に `assertValueQuoted`、`assertChoiceQuoted`、`choiceSourced`、`impliedQuote`、`querySourced` を置き、`mentioned`（4文字一致）を削除した。`assertQuoted` は `assertValueQuoted` の別名。ホスト側の再検査も同じ規則で拒否する。Skillと呼出しschemaの `quote` の説明を新しい規則に合わせた | **引用がない選択**は、ラベルと依頼が語の境界で共有する最長の文字列（暗黙の引用）がラベルの半分以上を覆えば通すようにした。設計では一律に `needs_input` としていたが、そうすると「ギフト包装あり」という依頼でラベル「ギフト包装にする」を選べず、既存のdev試験が落ちた。**明示した引用**は、ラベルと語句が重ならなければ通さない。これにより、2026-11-04のレビューで入れた「言い換えた引用（「贈り物」→「ギフト包装にする」）を認める」挙動は廃止した（試験も書き換えた） |
| R05 | `effectOf` を足した。URLのない（または `#…`、`javascript:` の）linkとmenuitemは `submit` になる | 試験用の偽のブラウザ（`lab/test/host/fake-adapter.ts`）のみなと市民ホールのページに、実物のfixtureと同じ `/url` 行を足した。実際のsnapshotにはリンクのURLがあるため |
| R06 | `transitionRun` が終端へ移るときに `core_state_json` を消す。`retainCoreState` と `lab run --retain-core-state` を足した | 定義runはcore stateを保存しないので、optionは足していない |
| R07 | `forgetRun` は4つの表を明示的に削除する。外部キーのON/OFFの両方と、`run_id` 列を持つ表の一覧を試験している | なし |
| R09 | `SELECT changes()` で更新件数を確かめる。対象は `saveCoreState`、`transitionRun`、操作の送出と確定、サイト知識のrevision付き更新、検索テンプレートのupsert（空振りは `stale_revision`） | 同じstatusへの冪等な更新（`applyCandidateStatus`）は、空振りが正常なので対象外 |
| R08 | `dist/HOST-CONTRACT.md` と `dist/conformance/host-vectors.json`（URL 25件、address 23件、値 5件、選択肢 6件、効果 8件）を配布物に入れた。`isPrivateHost`、`isPrivateAddress`、`cidrMatcher`、`privateIpv4` をlabから `/parts` へ移した（ロジックは変えていない）。package consumerとlabの試験が、ベクトルを全件通す | なし |
| R10 | 下線を含むhostで、知識の参照と検索テンプレートの参照がnullを返すようにした。`executor.ts` のtryの外にあった `new URL` を直した。3つの読み手の差を `src/definitions/origin.ts` の冒頭に書き、15件の入力表で固定した | **一本化はしなかった**。純粋な核には `URL` がなく、保存層は正規化済みの文字列を検査し、grantはWHATWGで読む。この3つは層ごとに前提が違い、まとめると3層の挙動が同時に変わる。代わりに差を文書と試験で固定した。比較の途中で、定義の検査が `https://127.0.0.1` や `0x7f.0.0.1`（WHATWGでは127.0.0.1）を通す不具合を見つけて直した |
| R11 | `createPartExecutor` を `src/host/parts/executor/` の7つのmodule（context 431行、index 158行、page 339行、item 130行、search 312行、form 287行、sort 223行）に分けた。共有状態は `ExecutorContext` に移した。`executor.ts` は5行のbarrelとして残し、既存のimportの経路を保った。試験は変更なしで同じ件数が通り、`/parts` の公開exportも一致した | context・sort・pageの間に循環importがある。実行時にだけ使う参照なので、初期化の順序には影響しない（Nodeでのdist読込み `check:dist` も成功）。R12より先に行う予定だったが、同じファイルの衝突を避けるためR12の後に行った |
| R12 | `src/core/shared/lexicon.ts` に8つのパターンを、0.1.xの正規表現と同じsourceとflagsで移した。executorは `PartExecutorDeps.lexicon` で差し替えられる | JSONファイルではなく、TypeScriptのデータmoduleにした。純粋な核からも読め、ビルドでJSONを写す必要がないため。差し替えられるのはexecutorだけで、要約、ページ内の並べ替え検査、bot checkの判定は既定のlexiconを使う。受入は「lexicon以外に、語句を含む正規表現が0件」とした。残っている日本語文字の正規表現は、区切り記号の文字クラス（「、」「・」「ー」）だけ |
| R13 | `:memory:` ではロックを取らない。MCPの出力ファイルに8 MiBの上限を設けた。撮影ファイル名をrunIdのhash 12文字にした。宙に浮いたdoc commentを移した。期限切れのgrantを掃除し、httpのgrantはloopbackだけに許す | coreの `indeterminate` の分岐は残した。packageとlabのホストからは届かないが、`PartResult` の公開型が `indeterminate` を許すため |
| R14 | READMEに「現在の状態」表を置いた。`plan.md`、`integration-design.md`、`improvement-progress.md` の状態の記述と、READMEの孤立した段落を直した | なし |
| R16 | `engines`（node >=24.11.1、bun >=1.4.4）を宣言した。依存を更新するときの確認項目を[運用](operations.md)に書いた | なし |
| F12 | source hashに `tsconfig.build.json`、ルートの `tsconfig.json`、`scripts/distribution-manifest.mjs`、`contract/` を足した | なし |
| R15 | 未実施 | 有料のため。上限と回数は利用者が決める（§8-4） |

### 独立した点検で直した点

変更の後に独立した点検を1回行い、指摘7件（重大度「高」はなし）と既存の危うい挙動2件をまとめて直した。

| 指摘 | 修正 |
| --- | --- |
| 語の境界がラテン文字と数字にしか効かず、「Да」が「Дальше」の中に、「예」が「예약하기」の中に一致した | スペースで区切る全ての文字体系（キリル、ギリシャ、ハングル、アラビア文字など）の文字と数字を語の文字とし、漢字・かな・タイ文字などだけを境界のない文字体系として扱う |
| 検索テンプレートの `stale_revision` で、カタログより新しいヒントを持つDBでは検索の部品が落ちる | labの `siteSearchUrl` がこの場合だけ保存済みのヒントを使い続ける |
| 引用付きの値の事前検査（`sameKey`）が、区切り記号の違いを許す規則と矛盾した | 事前検査を外し、`assertValueQuoted` の規則に一本化した |
| 書き換えた値（日付の書式など）が通らなくなることが明記されていない | [運用](operations.md)と§5の変更点に書いた |
| 期限切れのgrantを掃除すると、`use` のエラーが `grant_expired` から `grant_not_found` に変わる | 期限からさらに1期間（10分）経ったものだけを掃除する |
| `java\nscript:` のように途中に改行やタブを含むURLを、承認のないnavigationとして扱った | ブラウザと同じく、タブと改行を除き、両端の制御文字と空白を落としてから判定する |
| `verify` の木の比較がファイルの一覧だけで、変更済みのファイルをゲートが書き換えても気付かない | 変更済みのファイルと未追跡のファイルの中身のhashも比べる |
| （既存）区切り記号に長音「ー」が入っており、「ビール」と「ビル」が同じになる | 長音は数字の間でだけ区切りとして扱う。coreの `squash` と `spaced` を一つにし、`source.ts` はそれを使う |
| （既存）`impliedQuote` がラベルの長さの2乗に比例して遅くなる | 200文字を超えるラベルは探さない（部品は名前を120文字で切っている） |

### 検証

| 検証 | 結果 |
| --- | --- |
| `LAB_BROWSER_TESTS=1 bun run verify` | 成功（点検の修正後に再実行）。試験1280件 pass / 0 fail と、実Chromeの通信境界の試験2件。Node/Bunの配布物の検査（適合ベクトルを含む）も成功。検査の前後で作業ツリーは変わらなかった |
| scripted 20ケース（実Chrome、headless） | 20件とも成功。R04・R05による `needs_input` の増加はなかった |
| 負の対照（`scripts/check-negative-controls.py`） | 既存の5変異と新しい4変異（choice-source、core-state-cleared、forget-explicit、write-counted）の9件すべてで、元のコードでは試験が通り、変異では落ちた |
| 有料API | 呼んでいない |

## 11. 追加の改修（2026-11-06、第2弾）

利用者の指示「すべて改修してよい。Eumenesにも0.1.2として反映する」（同日）に基づく。版は0.2.0ではなく0.1.2とする（§5の0.2.0は0.1.2と読み替える）。モデルでの確認には、実際に使っているLuna（gpt-6-luna）を使い、既存の費用上限10 USDの範囲で行う。

| ID | 項目 | 内容 | 受入 |
| --- | --- | --- | --- |
| R17 | 検索の再送 | 検索欄への入力（`submit: true`）は、GETと決めつけて `recoverable` を付けている。ホストは、自分の検査でそのフォームがGET（またはフォームの外）と確認できたときだけ `recoverable` を認め、それ以外では結果が不明な送出を再送しない。HOST-CONTRACTの義務3に書く | POSTのフォームで不明な結果を `indeterminate` のまま止める試験。GETは従来どおり |
| R18 | menuitemのURL | 実際のPlaywright MCPのsnapshotで、`<a role="menuitem" href>` に `/url` が付くかを確かめる。付かないなら、`effectOf` がホストの検査（`<a href>` かどうか）で判定できるようにする | 実Chromeでの確認記録。URLのないmenuitemだけが承認を求める |
| R19 | grantの用途 | grantを使うときに用途（purpose）も照合する。Eumenesの照合と揃える | 別の用途の欄に、承認した値が入らない試験 |
| R20 | 信用しない印 | ページ由来の文字列（タイトル、URL、項目名、一覧、候補）すべてを、モデルに渡す結果の中でページ由来と分かるようにする（現状は `page.read` だけ） | 結果のJSONの試験。注入の試験が逸脱0のまま |
| R21 | page.openでの持ち出し | このrunで見たページの文字列（依頼にないもの）をURLに載せて、観測していないURLを開くときは承認を求める | 読んだ本文をqueryに載せたURLが承認待ちになる試験。観測したリンクや依頼由来の検索は従来どおり |
| R22 | runの存在の漏れ | `createRun` が、別ownerのrunの存在を区別できる形で返さない | 別ownerと同じownerで、同じエラーになる試験 |
| R23 | F10 | 失敗したAPI応答（HTTP、空、拒否、中断）にも、要求したprovider・model・effortと既知のattempt情報を共通の経路で付ける。返却modelが不明なら捏造しない。未知のusageと費用の予約は壊さない | 注入した各失敗で、metadataと予約が一致する試験 |
| R24 | F11 | 撮影の範囲を選ぶために、観測にある包含関係（どの項目がどの領域に入っているか）をLLMに渡す。撮影の結果にも、写した範囲に入っている要素を返す。商品語や特定IDの分岐は足さない | 固定ケースで範囲の一致・必要要素の包含・不要領域の除外を測る。Lunaで撮影ケースを再実行 |
| R25 | F09の一段 | 一覧のページ送りの判定に、語句ではなく構造（同じpathで数値のqueryだけが違うリンク、`/page/N`）を先に使い、lexiconは補助にする | 既存の一覧の試験とscripted 20ケースが維持され、語句を足さない |
| R26 | Eumenesへの反映 | 0.1.2のtgzをEumenesの `vendor/interact` に置き、`package.json`・lock・provenanceを更新する。本体のホスト（`interact-execution.ts` など）をR17・R19などの義務に合わせる。本体の未commitの他の変更には触れない | 本体の型検査と、interact関係の試験が通る |
| R27 | Lunaでの測定 | dev 20ケースと撮影・独立ケースをLunaで実行し、`needs_input`・誤完了・費用を記録する | 費用上限10 USD以内。失敗を含めて全試行を残す |

### 第2弾の結果

| ID | 結果 |
| --- | --- |
| R17 | labのホストは、自分の検査でフォームがGET（またはフォームの外）と分かったときだけ `recoverable` を認める。POST、`dialog`、method不明のフォームでは、結果が不明な送出を `indeterminate` のまま止める。Eumenesのホストはもともと `recoverable` を認めず、不明な結果で常に止まる |
| R18 | 実Chromeで確かめたところ、Playwright MCPのsnapshotは `<a role="menuitem" href>` に `/url` を付けなかった。部品の実行器は、ホストの `inspectTarget`（`<a>`/`<area>` の `href`）で宛先を判定する。packageのアダプタ、labとEumenesのdriverとhostに `href` を足した。実Chromeで、hrefのあるmenuitemはnavigation、`#`・hrefなし・`div` は承認待ちになった |
| R19 | `InputGrants.find` と `use` が用途（purpose）も照合する（Eumenesと同じく60文字で切った完全一致）。`form.fill` は欄のラベルを用途として渡す。Eumenesのホストも `grantPurpose` を受け取って渡す |
| R20 | モデルに渡す結果のうち、ページ由来の部分（page、list、read、capture、form、approval）に `untrusted: true` を付けた。配列の候補は `untrustedFields` で名前を示す |
| R21 | このrunで見ていないURLで、依頼にも先の結果にもないページの文字列（8文字以上）をpath・query・fragmentに載せた `page.open` は承認を求める。承認の画面に宛先のURLを出す（labとEumenes） |
| R22 | もともと別ownerでも同じownerでも `already_exists` を返しており、漏れはなかった。確認と挿入の間に衝突した場合も同じエラーにした |
| R23 | 失敗したAPI応答（HTTP、通信断、不正JSON、中断、schema、拒否、空、不完全）にも、要求したprovider・model・effortとHTTPの送信回数を記録する。返却modelは読めたときだけ記録する。未知のusageの予約は変えていない |
| R24 | ページの要約で、項目が入っているまとまり（`block`）と、まとまりが含む見出し・画像・項目（`holds`）を示す。`page.capture` の結果も、写した範囲と、そこに入っているものを返す。固定の採点（範囲の一致、必要な要素の包含、不要な領域の除外）を足した |
| R25 | 一覧のページ送りを、まず構造（同じpathで数値のqueryだけが違う、`/page/N`、数字や矢印だけの題名）で判定し、lexiconは補助にした。語句は足していない |
| 選択肢の規則の修正 | Lunaの実行で、`dev-form-multifield` が失敗した。Lunaは「ギフト包装あり」のように、依頼の一節をそのまま引用する。それがラベル「ギフト包装にする」と重なるのは一部だけなので、選択が拒否された。そこで、引用とラベルが語の境界で共有する最長の文字列がラベルの半分以上を覆えば通すようにした。修正後の再実行は成功した。「贈り物」「terms」「yesterday」の中の「yes」は、これまでどおり通らない |
| `--retain-core-state` | CLIがこのフラグを読んでも、実行に渡していなかった（第1弾の実装漏れ）。修正し、scriptedの実行でcore stateが残ることを確かめた |
| R27 | Luna（gpt-6-luna、effort low）で実行した。`dev-form-multifield` は修正前に失敗し、修正後に成功した。`dev-capture-item` は成功し、最終の報告が「見出しと商品の写真」の範囲を根拠にしていた。費用の台帳は596回・8.066335 USD（上限10 USD、呼出しの上限600回）。dev 20ケースをLunaで流すには、完了確認を含めて140回前後の呼出しが要り、残り4回では足りない。台帳の上限の変更は利用者が決める |

第2弾の後に独立した点検を1回行い、指摘6件をまとめて直した。

| 指摘 | 修正 |
| --- | --- |
| （高）Eumenesで、`page.open` の承認が宛先のURLに結び付いていない。同じページ・同じsnapshotなら、URL Aへの承認で別のURL Bも開けた | 承認の照合に、宛先のURLのhashを入れた（`interact-approval.ts`） |
| （中）Eumenesで、直前の操作が失敗して観測がないと、承認が必要な `page.open` の承認が省かれた | 承認が要るnavigationでは、観測を取り直してから承認を求める（`interact-execution.ts`） |
| （中）R21の検査が、ホスト名のサブドメインとuserinfoを見ていない | サブドメイン（末尾2つより左のラベル）とuserinfoも検査する |
| （低〜中）1文字のラベル（「男」「女」）が、引用付きでも選べなくなった | 引用がラベルを丸ごと含む場合も通す |
| （低）R21の検査が、長いURLと長いページで遅い（最悪約0.5秒） | URLの側の文字列を集合にし、ページは1回だけ走査する |
| （低）撮影の採点で、`holds` が切り詰められていても、除外の確認を合格にしていた | 切り詰められていて除外の指定がある場合は合格にしない |

検証: `LAB_BROWSER_TESTS=1 bun run verify` は試験1357件 pass / 0 fail で成功（実Chromeの通信境界の試験2件と、Node/Bunの配布物の検査を含む）。scripted 20ケースは20件とも成功。負の対照は9件すべてを検出した（R17で書き換わった承認の行に合わせて、既存の「approval」の変異の対象を直した）。

# lab/definitions 作業定義のサンプル

plan.md §6（JSONで持つ定義）、§7（サイト知識）、§9（承認）、§14（記録とデータ）に対応する。
キーワードを入力に取り、サイトで検索して、記事（商品）の本文を取り出す定義を4つ置いている。

| 定義 | サイト | 許可するorigin | 本文の取り出し |
| --- | --- | --- | --- |
| `wikipedia-article` | Wikipedia（日本語） | `https://ja.wikipedia.org` | `article.body`（`main`）を根にする |
| `gizmodo-article` | ギズモード・ジャパン | `https://www.gizmodo.jp` | 根を指定しない（汎用） |
| `slashdot-story` | Slashdot | `https://*.slashdot.org` | 汎用 |
| `biggo-product` | BigGo | `https://biggo.jp` | 汎用 |

定義の本体は`lab/definitions/<id>.json`（`parseDefinition`で検査される）、サイト知識は`lab/knowledge/<site>.json`にある。

## 外部から使う

CLIは`bun lab/cli/main.ts`（ルートの`package.json`に`"lab": "bun lab/cli/main.ts"`があれば`bun run lab`）。

```
bun lab/cli/main.ts task list
bun lab/cli/main.ts task run <definitionId> --input query=<キーワード> [--json]
    [--approver stop|cli] [--keep-observations] [--headed] [--browser chrome] [--executable-path <path>]
bun lab/cli/main.ts knowledge import <seed.json>...
bun lab/cli/main.ts knowledge list [--origin <origin>]
```

- `--input key=value`は何度でも書ける。最初の`=`で分けるので値に`=`を含められる。同じキーを2回書くとエラー。
- `task run`はリポジトリの`lab/knowledge/*.json`を先に取り込む（冪等）。`knowledge import`は単独でも使える。
- 実サイトを開くので、実行のたびに「ユーザー起動」の注意を標準エラーに出す。標準出力には`--json`のときJSONだけを出す。

### 終了コードとJSON

| 終了コード | 意味 |
| --- | --- |
| 0 | `ok: true`（全手順が`confirmed`か`skipped`で、runが`completed`） |
| 1 | runは始まったが完了しなかった（`failed`、`needs_input`、`cancelled`、`expired`、`indeterminate`）、または未知の定義などのエラー |
| 2 | 定義または入力が、runを作る前に拒否された（`status: "rejected"`） |

`--json`の結果:

```json
{
  "ok": true,
  "status": "completed",
  "code": null,
  "definition": { "id": "wikipedia-article", "revision": 1, "digest": "<sha256>" },
  "inputs": { "query": "機械学習" },
  "finalUrl": "https://ja.wikipedia.org/wiki/...",
  "steps": [
    { "id": "open", "action": "browser.navigate", "status": "confirmed" },
    { "id": "pick", "action": "page.click", "status": "skipped", "skipped": true }
  ],
  "extracts": {
    "read": { "url": "...", "title": "...", "text": "...", "charCount": 12345, "truncated": false, "root": "target" }
  },
  "runId": "<uuid>"
}
```

- `status`はrunの状態（plan.md §9）。拒否されたときだけ`"rejected"`で、`runId`は`null`、`issues`に`{ path, code }`の一覧が付く。
- クリックと、送信つきの入力（`submit: true`）の手順には、`urlChanged`（その手順でページのURLが変わったか）が付く。クリックは`confirmed`でも、ページ内のスクリプトが処理するだけでURLが変わらないことがあり、そのときは`false`になる。定義に式を足さずに、呼び出し側が見分けるための情報。
- 各手順に`durationMs`が付く。`page.observe`の手順には`bodyBytes`（プラットフォームが返したスナップショットのUTF-8バイト数）と`refCount`、`page.extract`の手順には`charCount`が付く。結果の最上位には`platform`と`tool`（`{ name, version }`。開く前に拒否されたときは`null`）がある。
- 手順の`status`は`confirmed` / `skipped` / `failed` / `needs_input` / `indeterminate` / `cancelled` / `expired` / `not_run`。止まった手順より後は`not_run`。
- 止まった理由は`code`（固定の分類）。主なもの:
  - `object_undefined`: 今のページの種類に、その手順の対象が知識に無い（optionalでない手順）
  - `target_not_found` / `target_ambiguous`: 対象は知識にあるが、今のページに無い、または複数ある
  - `candidate_unsupported`: 候補の項目をリゾルバが読めない
  - `approval_required`: 承認が要る操作（下記）
  - `navigation_out_of_scope` ほか`navigation_*`: 許可originの外へ行こうとした、またはそのページに着いた
  - `invalid_input`（拒否時）、`definition_revision_conflict`（同じidとrevisionで内容が違う）
- `extracts.<stepId>.root`は、根をどう選んだか（`target`は`targetObject`で指定、`article` / `main` / `largest-block` / `body`は汎用の順）。

### プログラムから

```ts
import { runDefinition } from "../host/definition-run.ts"; // lab/host/definition-run.ts
import { readDefinition } from "../host/definitions.ts";

const result = await runDefinition({
  db,                       // openLabDb() の接続（lab/host/db.ts）
  definition: await readDefinition("lab/definitions/wikipedia-article.json"),
  inputs: { query: "機械学習" },
  adapter,                  // 新しいPlatformAdapter。開いて、終了時に必ず閉じる
  logger,                   // LabLogger（lab/host/log.ts）
  approver,                 // 省略時は StopApprover（何も許可しない）
  control,                  // 省略可。RunControl.cancel() で取り消す
  observationSink,          // 省略可。付けた実行だけ、観測と抽出を保存する
});
if (!result.ok) { /* result.status, result.code, result.steps で分かる */ }
```

## 入力の規則

- 入力は定義の`inputs`（JSON Schemaの小さな部分集合）で検査される。サンプルは`query`（文字列、1〜100文字。文字数はNFC正規化後のコードポイント）だけで、宣言していないキーは`unknown_input`で拒否される。
- 値は式として評価されない。`{ "$input": "query" }`の置き換えだけで、コードやURLの組立てには使われない。
- 検索欄への入力は「利用者が渡した値」として扱い、ホストが参照で入力する。ログ・台帳・記録に値は残らない。

## 承認

- 手順の操作は、モデルの操作と同じ関門を通る（古い観測の拒否、URL方針、承認判定、台帳への記録、`dispatched`を送出前に書く）。
- 承認が要る操作（Eumenesの判定: 非GETフォームの送信、判定できない単純なボタンのクリック、宣言された確定）に当たると、既定の`--approver stop`は**何も送らず**に`needs_input`で止まり、結果の`approval`に何をしようとしたか（`action`, `page`, `element`, `summary`）を入れる。自動で許可することはない。
- `--approver cli`は端末で対象・操作・内容を見せて、y/Nで答える。
- サンプルの操作（GETの検索、リンクのクリック）は承認を要さないので、無人で最後まで動く。

## プライバシー（plan.md §14）

- 入力はJSONの結果に載るが、ログにも台帳にも書かない。DBに残るのは入力の組のsha256（`lab_definition_runs.inputs_sha256`）だけ。台帳の入力値の欄にも値は入らない。
- 抽出した本文と観測は結果として返すだけで、実サイトでは保存しない。要素名（ページ由来の文）も台帳には`(redacted)`で書く。
- `--keep-observations`を付けた実行だけが、観測と抽出を`lab/data/observations/<runId>/<seq>.txt`に残す。7日より古いものは次の`run`／`task run`の開始時に削除される。終了時にパスを表示する。
- 実行後の要約（`lab_definition_runs.summary_json`）の最終URLは、検索語を含みうるので、originとパスだけ。

## Eumenesとの違い（タブの追従）

Eumenesのホスト検査は、タブを「タブ番号とURLの両方が一致するあいだ」だけ同じタブとみなす。定義の実行では、自分の操作が`confirmed`になった直後の最初の確認に限り、ページがその後に落ち着いたURL（操作が返ったあとのリダイレクトや`replaceState`。例: Wikipediaの検索結果の`&ns0=1`）を採用する。条件は全部そろったときだけ:

- 操作の前に列挙したタブの数と、今のタブの数が同じ
- そのタブの番号に、ちょうど1つのタブがある
- ほかの追跡中のタブは、すべて番号とURLが一致している
- 新しいURLがその実行のURL方針を通る

採用すると、そのタブの世代を上げて古い観測を無効にし、`tab_url_settled`をログに残す。条件を満たさなければ従来どおり`tab_lost`、方針が拒否するURLならタブを`blocked`にする。モデルを通す実行（`run`）はEumenesの規則のまま。

## サイト知識の仕組み

- 定義は対象を論理名（`search.query`など）で名指しし、refは持たない。実行時に、今の観測（スナップショット全体）から候補で要素を探す。
- 候補は`role`（`role` + `name`か`nameAnyOf`）と`structure`（`role`, `name`/`nameAnyOf`, `named`, `urlIncludes`, `urlExcludes`, `withinRole`, `nth`）。`nameAnyOf`と`urlExcludes`は`a|b`。`urlIncludes`と`urlExcludes`はリンクの`/url:`を、そのままと、パーセントを戻した形の両方で調べる。
- ちょうど1つに当たるか、`nth`で明示した番号があれば使う。0個や複数個は、その手順で止まる（先頭を黙って選ばない）。候補が複数あるときは、同じ1つの要素を指す必要がある。
- ページの種類（page profile）は、URLのパスが`urlHint`で始まるもののうち最長のもの。`/`は全ページに当たる最後の手段。対象は、最長のprofileに無ければ、より短い当たるprofileから探す。
- `optional`の手順は、**対象が今のページの種類に定義されていない**ときだけ飛ばす（例: 題名が一致して記事へ直接移動したときの`search.first_result`）。定義はあるのにページに無い・複数ある場合は止まる。
- 取り込んだ知識は`candidate`で、`verified`にはならない。使った操作の確認として`object_evidence`（`match`、runと操作の参照つき）を残すだけ。
- 取り込みは冪等。種が変われば、期待する版でobjectを改訂し、種から消えた候補は`disabled`（`seed_changed`）にする。

## サイト別の注意

- **Wikipedia**: 題名が完全一致すると検索から記事へ直接移動するので、`pick`は飛ばされる。そうでなければ検索結果の最初の記事（ヘルプ・特別ページ・赤リンク・名前の無いサムネイルを除く）へ行く。
- **ギズモード・ジャパン**: 検索結果はGoogle CSEがページ内に出す（iframeではない）。結果のリンクは`https://www.gizmodo.jp/article/`で始まるものに限り、`google.com`のリンクは押さない。結果の表示を待つため3秒待つ。
- **Slashdot**: 許可originは`https://*.slashdot.org`（ストーリーは`tech.`、`yro.`、`games.`などのサブドメインにある）。`(techcrunch.com)`のような元記事の外部リンクは押さない（`/story/`を含むリンクだけ）。サブドメインのページに知識は無いので、本文は汎用の抽出。
- **BigGo**: ヘッドレスのChromeは`{"message":"Access denied"}`になる。**`--headed`が必要**。広告のリンク（`/r/?i=…`）は外部の店へ飛ぶので押さない（`/gp/`を含むものだけ）。結果ページの種類はまだ分かっていないので、知識は`/`だけ。

## 実行例

```
bun lab/cli/main.ts task run wikipedia-article --input query=機械学習 --json --browser chrome
bun lab/cli/main.ts task run gizmodo-article --input query=AI --browser chrome
bun lab/cli/main.ts task run slashdot-story --input query=linux --browser chrome
bun lab/cli/main.ts task run biggo-product --input query=イヤホン --headed --browser chrome
```

## プラットフォーム（Playwright MCPとAgent Browser）

`--platform playwright-mcp|agent-browser`（既定は`playwright-mcp`）で、`run`と`task run`の実行基盤を選ぶ。`--headed`は両方で効く。`--browser`と`--executable-path`は`@playwright/mcp`の引数なので、`agent-browser`と一緒に指定するとエラーにする（別のブラウザで測ることを防ぐ）。

- スナップショットの形が違う。Playwright MCPは`- link "名前" [ref=e3]:`と子の`- /url: …`、Agent Browserは`- link "名前" [ref=e27, url=https://…]`（属性は1つの括弧、リンク先は括弧の中）。リゾルバ・refの一覧・承認判定は両方を同じに読む（`lab/aria.ts`）。
- Agent Browserは、要素のタグやフォームの情報を読む道具が無い。承認が要るかを要素から判定できないので、**リンクのクリック以外**（ボタン、送信つきの入力、Enter）は承認待ちにする（plan.md §9の「効果を限定できない操作は確認待ち」）。無人の`--approver stop`では、検索の送信で`needs_input`（`approval_required`）で止まる。続けるには`--approver cli`で端末から答える。
- 定義の実行の記録（`lab_definition_runs`）と試行（`lab_trials`）に、`platform`とツールの名前・版が残る。

## 比較（compare）

```
bun lab/cli/main.ts compare --platforms playwright-mcp,agent-browser --include-live --headed
bun lab/cli/main.ts compare --platforms playwright-mcp,agent-browser --split dev --definitions none
```

- 定義×入力×プラットフォームを`--repeat`回、先に動かすプラットフォームを入れ替えながら実行する（plan.md §10.4）。入力は`lab/compare/inputs.json`（`--inputs <file>`で差し替え）。ヘッドレスで動かないサイトには`needsHeaded: true`が付いていて、`--headed`なしでは「skipped: needs --headed」として報告に残す。
- 定義は実サイトを開くので`--include-live`が要る。`--split dev`で、スクリプト推論のArm 0のdevケースも各プラットフォームで動かす。`--definitions`は`all`（既定）、`none`、またはidのカンマ区切り。
- `lab/data/reports/compare-<時刻>.json`と`.md`に、プラットフォーム×定義（ケース）ごとの成功率、所要時間の中央値と合計、スナップショットのバイト数とrefの中央値、抽出文字数、失敗の分類、「クリックしたのにURLが変わらなかった」回数を出す。所要時間にはブラウザの起動を含み、中央値は成功した実行だけで取る。
- 抽出した本文はレポートに載せない（文字数と先頭80文字だけ、ページのデータとして）。キーワードはユーザーが選んだサンプル入力なので載る。ログには入らない。

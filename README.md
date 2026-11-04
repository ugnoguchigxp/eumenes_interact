# eumenes_interact

EumenesのOS・ブラウザ操作を、独立した研究プロジェクトで実装と測定を繰り返しながら育てるための実験基盤です。成果は版付きtarball（`eumenes-interact`）としてEumenesへ持ち帰り、EumenesのSQLiteへ統合します。設計は[plan.md](plan.md)を正本とします。

## 構成

| 場所 | 内容 | 持ち帰るか |
| --- | --- | --- |
| `packages/eumenes-interact/src/contracts` | 公開契約（処理核のAPI、adapterのport、操作・観測、DB接続、推論port、run状態） | 入る |
| `packages/eumenes-interact/src/core` | 1手の処理核。Arm 0はEumenesのブラウザ担当（commit `98b188d2`）の移植 | 入る |
| `packages/eumenes-interact/src/sqlite` | ホストが渡すDB接続上で動くmigrationと保存関数（`interact_`テーブル） | 入る |
| `packages/eumenes-interact/src/adapters/playwright-mcp` | Playwright MCPとの接続（隔離ブラウザ） | 入る |
| `lab/host`、`lab/cli` | 研究用ホスト（実行ループ、承認、URL方針、記録）とCLI | 入らない |
| `lab/inference` | LARMのチャット推論接続 | 入らない |
| `lab/scripted` | 固定応答の受入用の台本推論 | 入らない |
| `lab/fixtures`、`lab/cases`、`lab/scorer` | 静的fixture、dev/holdoutのケース、採点器 | 入らない |
| `lab/arm0-golden` | Arm 0とEumenesの実関数の出力を突き合わせるgolden | 入らない |

パッケージの実行時依存は`zod`と`jsonrepair`だけです。処理核と`/sqlite`はIO・時計・bun固有APIを持たず、distはbunとNodeの両方から読めます。

## 必要なもの

- bun 1.4.4
- Node（`check:dist`でdistの読込みを確かめるとき。版は固定しない）
- 隣のディレクトリにあるEumenesのcheckout（`../eumenes`）。`check:stack`がEumenesと技術スタックを照合し、`lab/arm0-golden/generate.ts`がgoldenを作るときに読み取り専用で使います。場所は`EUMENES_DIR`で変えられます
- 実ブラウザで動かすときはGoogle Chrome（`--browser chrome`）

## セットアップと検証

```sh
bun install
bun test                 # 全試験
bun run typecheck        # 型検査
bun run typecheck:core   # 処理核と/sqliteを bun・node・DOM の型なしで検査
bun run lint
bun run format:check
bun run check:stack      # Eumenesと版・設定が一致するか
bun run check:dist       # ビルドしてNodeからdistを読めるか
```

## 研究用CLI

```sh
bun run lab cases                                  # devケースの一覧（holdoutは --include-holdout）
bun run lab run --case dev-search-base --inference scripted --browser chrome
bun run lab run --split dev --inference scripted --browser chrome
bun run lab trials
bun run lab report --experiment <実験id>
```

- `run`は、試行の間だけfixtureを`http://127.0.0.1:<空きポート>/`で配信し、隔離したブラウザをPlaywright MCPで起動して、終わると両方を止めます。既定はheadedで画面を表示します（interactはheadありで使う想定）。headlessにしたいときだけ`--headless`を付けます。`--headed`は受け付けますが何も変えません。
- 試行中の宛先はfixtureの配信元と`about:blank`だけです。
- 研究用DBとログは`lab/data/`（git管理外）に置きます。`run`は同時に一つだけ動きます。

### 作業定義のサンプル（検索語を変数にして本文を取得）

`lab/definitions/`の作業定義を、検索語を入力にして実行します。サイトごとの検索欄やリンクの見つけ方は、コードではなくサイト知識（`lab/knowledge/`、実行時に研究用DBへ取り込む）として持ちます。

```sh
bun run lab task list
bun run lab task run wikipedia-article --input query=量子コンピュータ --json --browser chrome
bun run lab task run gizmodo-article --input query=iPhone --json --browser chrome
bun run lab task run slashdot-story --input query=rust --json --browser chrome
bun run lab task run biggo-product --input query=マウス --json --browser chrome
```

- `--json`で、最終URL・各手順の状態・取得した本文（`extracts`）をJSONで標準出力に出します。終了コードは0が成功、1が完了しなかった、2が実行前の拒否です。TypeScriptからは`lab/host/definition-run.ts`の`runDefinition()`で呼べます。
- 承認が要る操作に当たると、既定では何も送らずに止まります（`--approver cli`で端末から答えられます）。
- BigGoは、headlessの自動化ブラウザだとアクセスを拒否されるため、`--headless`を付けずに（既定のheadedで）動かします。
- 詳しくは[lab/definitions/README.md](lab/definitions/README.md)を参照してください。

LARMで実LLMを使う場合:

```sh
LARM_API_TOKEN=... bun run lab larm profiles --base-url <LARMのURL>
LARM_API_TOKEN=... bun run lab larm set --base-url <LARMのURL> --profile <Profile名>
LARM_API_TOKEN=... bun run lab run --case dev-search-base --inference larm --browser chrome
```

トークンは環境変数からだけ読み、DBやログには保存しません。接続先はローカルかプライベートLANのアドレスに限ります。

## 状態

S1（核とArm 0）を実装済みです。実ブラウザでの台本推論の実走と、実LLMによる基準線の測定はこれからです。段階と完了条件は[plan.md](plan.md)の§15を参照してください。

## ライセンス

[MIT](LICENSE)

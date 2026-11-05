# eumenes_interact

LLMがブラウザ部品を選び、ホストが入力・承認・取消・保存・権限を検査する実験基盤です。現在はArm 1のブラウザ操作を実装しています。設計の正本は[plan.md](plan.md)、改善の進捗は[改善計画](docs/improvement-plan.md)と検証記録で管理します。Eumenes本体への統合とDesktop操作は受入前です。

## 始める

Bun 1.4.4とNode 24.11.1、実ブラウザ検証にはGoogle Chromeを使います。隣の開発checkoutなしで依存を導入できます。

```sh
bun install --frozen-lockfile --ignore-scripts
bun run verify
bun run lab run --case dev-search-base --inference scripted --browser chrome --headless
```

`verify`は型、核の型、lint、整形、固定依存の内容、全試験、Nodeのdist読込み、tgzを単独導入したNode/Bun consumerを検査します。実Chromeの権限境界は `LAB_BROWSER_TESTS=1 bun test lab/test/host/net-guard.browser.test.ts`、20ケースの通しは `bun run lab run --split dev --inference scripted --browser chrome --headless` で実行できます。API呼出しはこれらの検証に含めません。

## 共通のAPIキーを使う

ログインシェルに設定した `CLAUDE_API_KEY` と `OPEN_AI_API_KEY` をそのまま使えます。標準名の `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` があればそちらを優先します。プロジェクトごとの.envは不要です。設定後の古いターミナルでは、一度 `source ~/.zprofile` で環境を読み直します。CLIが毎回シェル設定を実行することはありません。

```sh
bun run lab run --case dev-search-base --inference claude --browser chrome --headless
bun run lab run --case dev-search-base --inference openai --model gpt-6-luna --browser chrome --headless
```

有料呼出しは、両provider共通の `lab/data/api-spend.sqlite` で最大10USDまで送信前に費用枠を確保します。出力上限を守り、自動retryを行いません。応答や使用量が不明な呼出しを無料として扱いません。検証途中に台帳を消したり、別の台帳へ切り替えたりしないでください。実行結果・失敗・確保額は[検証記録](docs/reviews/2026-11-05/implementation/)に残します。

## 公開パッケージ

| 入口 | 内容 |
| --- | --- |
| eumenes-interact | 純粋な1手の処理核と公開契約 |
| eumenes-interact/sqlite | ホスト所有の接続上で使うmigrationと保存・サイト知識 |
| eumenes-interact/parts | 同じ部品実装、registry、capture、注入する実行port |
| eumenes-interact/adapters/playwright-mcp | 隔離したPlaywright MCP接続 |

`bun run check:package` は配布tgzを作り、空のconsumerへ導入して全公開部分、SQLite、部品の通常・拒否・承認、改変検出をNode/Bunで確認します。配布物にはSkill、migrationのdigest、実体のhash、実行時依存のライセンスを含めます。packageは勝手にDBやブラウザ、推論ループを起動しません。

研究用CLI・MCP・実験scorerはlabに置きます。`run`のDB・ログ・撮影は `lab/data/` に保存し、Gitへ入れません。通常は隔離ブラウザを使い、操作終了時に閉じます。`chain`は元依頼からLLMが計画し、結果を見せる段だけ期限付きでブラウザを残します。

## 運用と状態

[CLIの使い方](lab/README.md)、[MCP](lab/mcp/README.md)、[更新・復旧・削除](docs/operations.md)、[Eumenes統合案](docs/integration-design.md)を参照してください。completed、partial、needs_input、cancelled、expired、indeterminateを区別し、部分結果や不明な送出を成功として採用しません。

LARMの設定用コマンドは残っていますが、現在のArm 1が必要とする構造化出力への接続は未対応です。Claude、OpenAI、scriptedまたはmanualを使います。Eumenesとのスタック比較は本体checkoutがある環境で `bun run check:stack` を実行します。Zodの安全修正に伴う差は[依存の記録](docs/security-dependency-overrides.md)に明示しています。

技術品質80点以上の正式な再評価は、改善と受入が揃った時点で行います。計画の目標値を実測値として扱いません。

## ライセンス

[MIT](LICENSE)。配布依存の通知は生成するdist/licensesとdist/third-party.jsonに含みます。

有料のブラウザ実行は、ClaudeとLunaの両方で完了を確認します。両方のAPIキーをログイン環境へ設定してください。確認2回も通常の推論回数上限に含め、どちらかが未達・不明を返した場合は完了として採用しません。

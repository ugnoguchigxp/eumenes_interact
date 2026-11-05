# 依存の安全修正とスタック差

2026-11-05。Zod 4.4.3→4.6.6、MCP SDK 1.31.0→1.32.0。root overridesも同じ版に固定し、推移依存の旧版を残さない。

Zodは配布するschemaと外部JSONの検査に到達する。大きな集合によるメモリ枯渇は、ローカルのagentでも外部観測・出力を受け取るため無関係としない。[公式advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)

MCPは現在stdioで、HTTP用の認証と実験tasksは利用していない。ただし今後のtransport変更を安全と推測せず、HTTP検査とsession分離の修正版を採用する。[session境界](https://github.com/advisories/GHSA-22jm-h49p-29qw)、[メモリ枯渇](https://github.com/advisories/GHSA-46jr-4wx8-v453)

Eumenes本体は変更しない。check:stackでは、Eumenesが4.4.3の間だけ、このrepoのZod 4.6.6を根拠付きの差として許容する。他の差は引き続き検査する。本体が修正版へ上がった時点でこの例外を削除し、両側の結合試験を再実行する。月次と依存更新時にbun auditと契約試験で再確認する。監査0件は未知の脆弱性がないことの証明ではない。

# eumenes-interact ホスト契約

このpackageは、部品の宣言（`declaredEffect`、`inputProvenance`）と判定の関数を持ちます。実際の承認、送出、通信の制限はホストが行います。この文書は、ホストが守る義務を定めます（設計 R08）。同梱の `conformance/host-vectors.json` は、ホストの実装が同じ判定をすることを確かめるための入力表です。

## 義務

1. **送信前に値の出所を再検査する。** `inputProvenance.kind` が `request_quote` の操作は、送信の直前に `assertValueQuoted(text, quote, request)` で検査します。`grant` の場合は、grantをそのページのoriginで解決します。モデルの呼出しも、packageの部品の事前検査も信用しません。
2. **台帳に記録してから送る。** `recordOperationIntent` → `markOperationDispatched` をcommitしてからadapterへ送ります。結果を受け取ったら `settleOperation` で確定します。
3. **結果が不明な操作を再送しない。** `indeterminate` の操作は再送しません。`recoverable` は、冪等だと確認できた操作にだけ付けます。
4. **承認が必要な効果を止める。** `declaredEffect` が `submit` の操作は、利用者の承認を得てから送ります。URLを持たないlinkやmenuitemは、部品の側で `submit` と宣言されます（`effectOf`）。
5. **遷移先を検査する。** 資格情報付きのURL、http(s)以外のscheme、private、loopback、link-localのhostを拒否します（`isPrivateHost`）。研究用fixtureのloopbackだけは、明示した一つのoriginに限って許してかまいません。
6. **通信の経路を閉じる。** ブラウザは `BROWSER_LAUNCH_ARGS` で起動し、QUICと、proxyを通らないUDPを止めます。HTTPはproxyで検査し、名前を解決した後の全addressを `isPrivateAddress` で確かめてから接続します。
7. **保存の範囲を守る。** 終端したrunのcore stateは、`transitionRun` によって消えます。研究のために残す場合だけ `retainCoreState: true` を明示します。`forgetRun` は外部キーの設定に依存しません。

## 適合ベクトル

`conformance/host-vectors.json` の各表を、ホスト自身の実装に流してください。

| 表 | 流す先 | 期待 |
| --- | --- | --- |
| `urls` | 実runのURL policy（open webを許す設定、DNSは引かない） | `allow` のとおり |
| `addresses` | 通信guardのaddress判定 | `private` のとおり |
| `values` | 送信前の値の再検査（義務1） | `accept` のとおり |
| `choices` | 選択肢の出所の検査（`assertChoiceQuoted`） | `accept` のとおり |
| `effects` | `item.open` が宣言する効果（`effectOf`） | `effect` のとおり |

package自身の関数がこの表どおりに判定することは、配布物の検査（`check:package`）で確かめています。

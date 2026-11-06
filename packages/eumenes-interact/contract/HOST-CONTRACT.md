# eumenes-interact ホスト契約

このpackageは、部品の宣言（`declaredEffect`、`inputProvenance`）と判定の関数を持ちます。実際の承認、送出、通信の制限はホストが行います。この文書は、ホストが守る義務を定めます（設計 R08）。同梱の `conformance/host-vectors.json` は、ホストの実装が同じ判定をすることを確かめるための入力表です。

## 義務

1. **送信前に値の出所を再検査する。** `inputProvenance.kind` が `request_quote` の操作は、送信の直前に `assertValueQuoted(text, quote, request)` で検査します。`grant` の場合は、grantをそのページのoriginと、承認されたときの用途（purpose。Eumenesの `useInTransaction` と同じく60文字で切って完全一致）で解決します。用途は、部品の実行器が `ExecuteOptions.grantPurpose`（`form.fill` ではその欄のラベル）で渡します。ホストは `InputGrants.use(ref, pageUrl, grantPurpose)` に渡してください。渡さなければ、0.1.xと同じくoriginだけの照合になります。モデルの呼出しも、packageの部品の事前検査も信用しません。
2. **台帳に記録してから送る。** `recordOperationIntent` → `markOperationDispatched` をcommitしてからadapterへ送ります。結果を受け取ったら `settleOperation` で確定します。
3. **結果が不明な操作を再送しない。** `indeterminate` の操作は再送しません。部品が付ける `recoverable`（検索欄への入力など）は「再送しても害がない」という**要請**であり、保証ではありません。ホストは、自分の検査（`inspectTarget` の `inForm`、`formMethod`）で、対象がGETのフォームまたはフォームの外と確認できたときにだけ認めます。POST、`dialog`、method不明のフォームでは、結果が不明な送出を `indeterminate` のまま止め、再送しません。navigation、back、waitは常に冪等として扱ってかまいません。
4. **承認が必要な効果を止める。** `declaredEffect` が `submit` の操作は、利用者の承認を得てから送ります。`browser.navigate` も対象です。部品の `page.open` は、このrunで見ていない（ページのURLでもリンクでもない）URLで、依頼にも先の結果にもない、このrunで読んだページの文字列（8文字以上の共通の連なり）をpath・query・fragmentに載せたものを `submit` と宣言します（設計 R21）。承認の画面には宛先のURLを示してください。URLを持たないlinkやmenuitemは、部品の側で `submit` と宣言されます（`effectOf`）。Playwright MCPのsnapshotは `<a role="menuitem" href>` に `/url` 行を付けないため、部品の実行器は、ホストが `PartExecutionPort.inspectTarget` を持つ場合、そのような項目の `href` 属性を固定の検査で読み、宛先の有無を判定します。ポートがない、または検査が `href` を返さないときは、URLのない項目として承認を求めます。
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
| `effects` | `item.open` が宣言する効果（`effectOf`）。`inspection` を持つ行は、`inspectTarget` を実装するホストだけが流す | `effect` のとおり |

package自身の関数がこの表どおりに判定することは、配布物の検査（`check:package`）で確かめています。

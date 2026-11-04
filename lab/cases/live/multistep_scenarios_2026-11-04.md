# 多段シナリオ（判定基準は実行前に固定, 2026-11-04 JST）
各シナリオ共通: C0 計画の段数・順序が依頼どおり / Ch 後段の検索語が依頼か前段の結果に出所を持つ / 予算内 / ログイン・送信・購入なし。
S1 PyPIで requests の最新版を調べ、GitHubでそのリポジトリのスター数を見て、まとめる
  C1 版番号を PyPI のページから得る / C2 GitHub の psf/requests ページに到達 / C3 要約が両段の事実だけ
S2 crates.io で serde の最新版とダウンロード数を調べ、まとめる
  C1 serde のページに到達 / C2 版番号とダウンロード数 / C3 要約
S3 Hacker News のトップ記事のタイトルとポイントを調べ、まとめる
  C1 1位の記事タイトル / C2 ポイント数 / C3 要約
S4 ウィキペディアで富士山の標高を調べ、OpenStreetMapで富士山を検索して、まとめる
  C1 3776 m / C2 OSM 検索結果に富士山 / C3 要約
S5 Gutenbergで Pride and Prejudice の著者を調べ、Open Libraryで同じ本を探して、まとめる
  C1 Jane Austen / C2 Open Library の該当作品 / C3 要約
S6 MusicBrainzで Radiohead の最初のスタジオアルバムを調べ、YouTubeでそのアルバムの曲を再生して
  C1 Pablo Honey (1993) / C2 YouTube で再生、終了後 ≥30s currentTime 増加を計測 / C3 開いたまま→完了で閉じる
S7 世界銀行で日本の人口を調べ、ウィキペディアの日本の記事の人口と比べて、まとめる
  C1 WB の人口値（page.find Population 再確認） / C2 Wikipedia の人口値 / C3 比較
S8 MDNで Array.prototype.flat を調べ、Stack Overflowで flat の質問を探して、まとめる
  C1 MDN の flat ページ（site.search 再確認） / C2 SO 結果 or site_blocked を正しく報告 / C3 要約
S9 npmで zod のライセンスを調べ、GitHubでそのリポジトリを開いて、まとめる
  C1 MIT（Cloudflare なら待つ/site_blocked、偽の成功なし） / C2 GitHub colinhacks/zod / C3 要約
S10 tenki.jpで札幌の今日の天気を調べ、まとめる
  C1 札幌の予報ページ（検索結果の並び再確認） / C2 天気と気温を page.read で取得 / C3 要約
S11 arXivで Attention Is All You Need の投稿年を調べ、YouTubeでその論文の解説動画を再生して
  C1 2017 / C2 再生、≥30s currentTime 増加 / C3 開いたまま

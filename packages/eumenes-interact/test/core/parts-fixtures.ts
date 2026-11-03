/** Snapshots of small pages, in the two text formats the parts read. */

/** Playwright MCP: a search results page. The paragraph text must never reach a summary. */
export const RESULTS = [
	"- banner [ref=e2]:",
	'  - link "ほしくず商店" [ref=e3] [cursor=pointer]:',
	"    - /url: /",
	'  - navigation "メインメニュー" [ref=e4]:',
	'    - link "ホーム" [ref=e5] [cursor=pointer]:',
	"      - /url: /",
	'    - link "ヘルプ" [ref=e6] [cursor=pointer]:',
	"      - /url: /help",
	"  - search [ref=e7]:",
	'    - searchbox "商品を検索" [ref=e8]: 電気ケトル',
	'    - button "検索" [ref=e9] [cursor=pointer]',
	"- main [ref=e10]:",
	'  - heading "「電気ケトル」の検索結果" [level=1] [ref=e11]',
	"  - paragraph [ref=e12]: 3件が見つかりました。この文は要約に出てはいけません。",
	"  - list [ref=e13]:",
	"    - listitem [ref=e14]:",
	'      - link "電気ケトル 1.0L" [ref=e15] [cursor=pointer]:',
	"        - /url: /items/kettle-10",
	"      - text: ¥3,980",
	"    - listitem [ref=e16]:",
	'      - link "電気ケトル 0.8L" [ref=e17] [cursor=pointer]:',
	"        - /url: /items/kettle-08",
	"      - text: ¥2,980",
	"    - listitem [ref=e18]:",
	'      - link "詳細" [ref=e19]:',
	"        - /url: /items/a",
	'      - link "詳細" [ref=e20]:',
	"        - /url: /items/b",
	"- contentinfo [ref=e21]:",
	'  - link "利用規約" [ref=e22] [cursor=pointer]:',
	"    - /url: /terms",
].join("\n");

/** Playwright MCP: a form page with a required field, a filled one, options and a submit button. */
export const FORM = [
	"- banner [ref=e1]:",
	'  - link "ホーム" [ref=e2]:',
	"    - /url: /",
	"- main [ref=e5]:",
	'  - heading "お問い合わせ" [level=1] [ref=e6]',
	'  - form "お問い合わせフォーム" [ref=e7]:',
	'    - textbox "お名前" [required] [ref=e8]',
	'    - textbox "メール" [required] [ref=e9]: taro@example.com',
	'    - combobox "種別" [ref=e10]:',
	'      - option "質問" [selected]',
	'      - option "要望"',
	'    - checkbox "メールでの返信を希望する" [checked] [ref=e11]',
	'    - radio "個人" [ref=e12]',
	'    - radio "法人" [checked] [ref=e13]',
	'    - button "送信" [ref=e14] [cursor=pointer]',
	'    - button "リセット" [ref=e15]',
	'  - button "ページ上部へ" [ref=e16]',
].join("\n");

/** Bracketed attributes, a compact tree: landmarks and interactive elements, no paragraph text. */
export const COMPACT = [
	"- banner:",
	'  - link "Wikipedia" [ref=e1, url=https://ja.wikipedia.org/wiki/Main]',
	'  - searchbox "Wikipedia内を検索" [ref=e26]',
	"- main:",
	'  - heading "メインページ" [level=1]',
	'  - link "寄付" [ref=e27, url=https://donate.wikimedia.org/?wmf_source=donate]',
	'  - radio "小" [checked=false, ref=e322]',
	'  - radio "大" [checked=true, ref=e323]',
	'  - button "検索" [disabled, ref=e28]',
].join("\n");

/** Playwright MCP: a table whose rows hold links. */
export const TABLE = [
	"- main [ref=e1]:",
	"  - table [ref=e2]:",
	'    - row "名前 価格" [ref=e3]:',
	'      - columnheader "名前"',
	'      - columnheader "価格"',
	'    - row "電気ケトル ¥3,980" [ref=e4]:',
	'      - cell "電気ケトル" [ref=e5]:',
	'        - link "電気ケトル" [ref=e6]:',
	"          - /url: /items/kettle-10",
	'      - cell "¥3,980" [ref=e7]',
	"    - row [ref=e8]:",
	"      - cell:",
	"        - text: ハンドドリップセット",
	"      - cell: ¥5,400",
].join("\n");

export const raw = (
	body: string,
	extra: { url?: string; title?: string } = {},
) => ({
	body,
	truncated: false,
	missing: [] as never[],
	...extra,
});

/** Playwright MCP: a product card as an article, with other content blocks around it. */
export const CARD = [
	"- main [ref=e1]:",
	'  - heading "商品" [level=1] [ref=e2]',
	'  - article "商品の詳細" [ref=e3]:',
	'    - heading "電気ケトル 1.0L" [level=2] [ref=e4]',
	'    - img "電気ケトルの写真" [ref=e5]',
	"    - text: ¥3,980",
	'    - button "カートに入れる" [ref=e6]',
	"  - img [ref=e7]",
	"  - complementary [ref=e8]:",
	'    - link "ヘルプ" [ref=e9]:',
	"      - /url: /help",
	'  - complementary "関連商品" [ref=e10]:',
	'    - link "ハンドドリップセット" [ref=e11]:',
	"      - /url: /items/drip-set",
	'  - table "仕様" [ref=e12]',
	"  - figure [ref=e13]",
	"  - region [ref=e14]",
].join("\n");

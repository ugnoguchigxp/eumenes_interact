window.BOOKS = [
	{
		id: "1",
		title: "月影の図書館",
		author: "白波 ミオ",
		price: 1540,
		stock: 3,
	},
	{
		id: "2",
		title: "月影の図書館 外伝",
		author: "白波 ミオ",
		price: 1320,
		stock: 0,
	},
	{
		id: "3",
		title: "星屑の地図帳",
		author: "天野 カイ",
		price: 2200,
		stock: 5,
	},
	{
		id: "4",
		title: "潮風レシピ帖",
		author: "小川 ナギ",
		price: 1760,
		stock: 2,
	},
	{ id: "5", title: "潮風と灯台", author: "小川 ナギ", price: 1430, stock: 0 },
	{
		id: "6",
		title: "夜明けの天文学入門",
		author: "天野 カイ",
		price: 1980,
		stock: 4,
	},
];
window.norm = (s) =>
	(s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
window.findBooks = (q) => {
	const n = window.norm(q);
	return n
		? window.BOOKS.filter((b) => window.norm(b.title + b.author).includes(n))
		: [];
};
window.getBook = (id) => window.BOOKS.find((b) => b.id === id);

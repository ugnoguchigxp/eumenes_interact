window.PRODUCTS = [
	{
		id: "1",
		name: "麻のふきん",
		price: 880,
		material: "麻",
	},
	{
		id: "2",
		name: "木のスプーン",
		price: 660,
		material: "桜の木",
	},
	{
		id: "3",
		name: "陶器の小皿",
		price: 1320,
		material: "磁器",
	},
	{
		id: "4",
		name: "綿のポーチ",
		price: 1540,
		material: "綿",
	},
	{
		id: "5",
		name: "麻のエプロン",
		price: 3960,
		material: "麻",
	},
	{
		id: "6",
		name: "木のまな板",
		price: 2640,
		material: "ひのき",
	},
];
window.norm = (s) =>
	(s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
window.findProducts = (q) => {
	const n = window.norm(q);
	return n
		? window.PRODUCTS.filter((p) =>
				window.norm(p.name + p.material).includes(n),
			)
		: [];
};
window.getProduct = (id) => window.PRODUCTS.find((p) => p.id === id);

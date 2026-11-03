window.ITEMS = [
	{ id: "1", title: "宇宙のしくみ", branch: "central", status: "貸出可" },
	{
		id: "2",
		title: "宇宙飛行士の一日",
		branch: "east",
		status: "貸出中（返却予定 11月20日）",
	},
	{ id: "3", title: "海の生きもの図鑑", branch: "central", status: "貸出可" },
	{
		id: "4",
		title: "宇宙と時間",
		branch: "central",
		status: "貸出中（返却予定 11月12日）",
	},
	{ id: "5", title: "森の鳥たち", branch: "east", status: "貸出可" },
];
window.BRANCHES = { central: "中央館", east: "東分館" };
window.norm = (s) =>
	(s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
window.findItems = (q, branch) =>
	window.ITEMS.filter(
		(i) =>
			window.norm(q) &&
			window.norm(i.title).includes(window.norm(q)) &&
			(!branch || i.branch === branch),
	);

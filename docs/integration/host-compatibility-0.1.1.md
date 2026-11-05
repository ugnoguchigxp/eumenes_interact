# 本体ホストとの契約の補完

2026-11-05。Eumenes統合設計に沿った取り込みのための最小追加。

- 本体からpackage所有のrunを直接SQLで削除せずに済むよう、/sqliteへforgetRunを追加。writer transaction、ownerと終端状態を検査し、runと操作・計画およびサイト知識の根拠参照を削除する。active runの停止はホストが先に行う。
- 本体の既存撮影は固定品質WebPへ変換して保存するため、公開partsの保存結果と記録portにimage/webpを追加。撮影入力のPNG/JPEG契約と既存CaptureStoreの保存挙動は変えない。
- バージョン0.1.1、contractVersion2/coreFormat1を維持。新しい意味判断・分岐や推論モデル設定を追加しない。

型検査、SQLite試験、Node/Bun別consumerの実tgz検証を記録する。既存の81.9点評価は5bdef97の0.1.0の評価として保存し、今回のAPI追加を採点済みと呼び替えない。有料APIは追加しない。

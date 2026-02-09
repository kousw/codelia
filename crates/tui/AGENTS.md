# codelia-tui

Ratatui + crossterm で構成するフルスクリーンTUI。上部にロゴ、会話ログの履歴、入力欄、ステータス行を表示する。
alternate screen は使わず、UIの必要高さに合わせて inline viewport を調整して通常バッファに描画する。MouseCapture はデフォルトOFF。
runtime を spawn し、UIプロトコルで initialize/run.start を送ってイベントを表示する。
initialize では `ui_capabilities.supports_confirm=true` を送信する。
runtime から `ui.confirm.request` を受信すると確認パネルを表示し、Y/Enter で許可、N/Esc で拒否する。
確認パネルの選択肢（ラベル/remember/reason）は request params で制御され、用途ごとに Yes/No 専用や権限確認向け UI を切り替える。
入力欄はチャットの送信欄として動作し、Enter で run.start を送信できる（チャット形式）。
`-r/--resume` で session.list を呼び出して再開セッションを選択できる（run.start に session_id を付与）。
resume で session.history を呼び、過去 run の agent.event を再描画する。
`/model` コマンドは provider 選択→モデル一覧（詳細）を入力欄パネルに表示し、Enter で model.set を送る。
`/mcp` / `/mcp <server-id>` で runtime の `mcp.list` を呼び出し、MCP server 状態を表示する。
`/skills` で runtime の `skills.list` を呼び出し、skills picker パネルを表示する。
skills picker では type 入力で検索、`Tab` で scope（all/repo/user）切替、`Space`/`e` で有効/無効トグル、`Enter` で `$skill-name` を入力欄へ挿入する。
`/context`（`/context brief`）で runtime の `context.inspect` を呼び出し、AGENTS.md の読み込みパスを含む現在コンテキストを一覧表示する。
`/compact` で `run.start(force_compaction=true)` を送り、通常のユーザ入力なしで compaction を強制実行する。
`/logout` で `auth.logout(clear_session=true)` を送り、確認ダイアログの承認後に保存済み auth と現在セッション参照をクリアする。
`/help` で利用可能な slash コマンド一覧をログに表示する。
入力欄が `/` で始まるときは、入力パネル下に slash コマンド候補を表示する。
入力欄の末尾トークンが `$skill-prefix` のときは、入力パネル下に skill 候補を表示する（ローカル catalog ベース）。
未知の slash コマンドは通常メッセージとして送信せず `command not found` を表示する（`/help` 案内つき）。
通常入力時に `Tab` を押すと slash コマンド補完を優先し、該当しない場合は `$skill-prefix` 補完を行う（一意一致は確定+空白、複数一致は共通接頭辞まで）。
選択 UI は入力欄のパネルを拡張して表示する（Esc で閉じる）。選択中の行は左に `>` を表示する。
ログは色分け（user/reasoning/tool/result/status/runtime）して表示し、inline モードでは
溢れたログ行をターミナルの scrollback へ挿入して履歴として残す。
各アクションは左アイコン付きのサマリ行 + 軽いインデントの詳細行で表示し、サマリ/詳細で色調を変える。
実行中はステータス行にスピナーを表示し、完了時に処理時間を最終レスポンス直前へ挿入する。
run.start 応答待ち中は `starting` を表示してスピナーを回し、MCP 接続待ちを可視化する。
OAuth が必要な MCP 接続は browser 起動確認ダイアログを表示し、localhost callback 完了まで `awaiting_ui` で待機する。
`mcp: Connecting MCP server` / `mcp: MCP auth required` / `mcp: MCP server ready` は debug print が OFF でも Status 行として表示する。
`mcp[... ] connect failed` / `MCP server error` は debug print が OFF でも Error 行として表示する。
`[runtime]` の一般ログは debug print が OFF のとき非表示のままにし、`Error:` や `panic` などクラッシュ手掛かりになる行だけ常時 Error 行として表示する。
prompt / confirm パネル本文はパネル幅で折り返して描画する。confirm パネルは本文が長くても選択肢ブロック（Yes/No/remember）が常に見えるよう末尾側を優先表示する。
`ui.prompt.request` の `secret=true` は入力内容を `*` でマスク表示する（送信値は保持）。
日本語入力の横スクロールに対応するため、入力欄は unicode width を考慮する。
assistant メッセージは markdown 前提なので、最低限の簡易レンダリング（コードフェンス/見出し/箇条書き/引用/インライン装飾の除去）を行う。
tool result / code block には制御文字や ANSI escape が混ざることがあるため、TUI 側で sanitize してから描画する（タブ展開・ANSI strip・CR除去）。
入力欄への paste は `sanitize_paste` で整形し、改行は保持したまま CRLF/CR を LF に正規化し、タブ/制御文字も正規化する。
起動時に bracketed paste を有効化し、マルチライン貼り付けが Enter の連続押下として誤解釈されないようにする。
端末モード復帰（raw mode / bracketed paste / keyboard enhancement flags / mouse capture / cursor）は Drop ガードで保証する。

モジュール構成:
- `src/main.rs`: crossterm のイベントループ、runtime との接続、描画トリガ
- `src/handlers/command.rs`: slash コマンド処理と通常入力 submit の分岐
- `src/handlers/panels.rs`: model/session/context 各パネルのキー操作ハンドラ
- `src/runtime.rs`: runtime spawn + initialize/run.start 送信
- `src/parse.rs`: runtime の JSON line を parse して LogLine に変換
- `src/ui.rs`: ratatui 描画（logo/log/input/status）
- `src/input.rs`: 入力欄の編集/履歴
- `src/markdown.rs`: assistant markdown の簡易レンダリング
- `src/model.rs`: LogKind / LogLine
- `src/text.rs`: unicode 幅、wrap、sanitize

実行例（開発用）:
- cargo run --manifest-path crates/tui/Cargo.toml
- CODELIA_RUNTIME_CMD=bun CODELIA_RUNTIME_ARGS="packages/runtime/src/index.ts" cargo run --manifest-path crates/tui/Cargo.toml "hi"
- CODELIA_DEBUG=1 を付けると runtime/RPC のログを表示する

操作:
- 入力して Enter で送信
- 改行: `Ctrl+J`（対応端末では `Shift+Enter` も可だが、端末/IME によっては区別できない）
- `ui.prompt.request` の multiline 入力でも `Ctrl+J` で改行できる。
- マルチライン入力中の `Up/Down` は行間カーソル移動を優先し、上下端では履歴移動にフォールバックする
- ログスクロール: `PgUp` / `PgDn` / マウスホイール（MouseCapture を有効化している）
- `Alt+H` でステータス行の Info/Help を切り替え
- `F2` で MouseCapture の on/off（コピーしたい時は off 推奨）
- `Esc` は戻る（パネルを閉じる / スクロール解除 / 入力クリア）
- `Ctrl+C` で終了

起動時:
- `model.list` を呼んで current provider/model を初期ロードする（パネルは開かない）。
- `supports_skills_list=true` の場合、`skills.list` をバックグラウンドで1回取得し、`$skill` 補完候補の catalog を温める。

キー入力メモ:
- `Shift+Enter` を確実に取るには端末側が modifier 情報を送る必要がある。TUI 側では kitty keyboard protocol を有効化してみるが、未対応端末では `Shift+Enter` は通常の `Enter` と区別できない（その場合は `Ctrl+J` / `Alt+Enter` を使う）。`REPORT_ALL_KEYS_AS_ESCAPE_CODES` を有効化すると一部端末で拡張キープロトコル自体が失敗し、修飾キーが落ちるため使わない。

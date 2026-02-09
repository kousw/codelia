# Sandbox Isolation Spec（worker 実行セキュリティ）

この文書は、`agentic-web` の worker 実行における sandbox セキュリティ手法を整理し、後続実装の意思決定基準を定義する。
主眼は「セッション分離の整合性（運用）と、越境アクセス防止（セキュリティ）を分けて設計する」こと。

---

## 0. 背景

`basic-web` / `agentic-web` では、run は worker プロセス上で実行される。
現時点で導入済みなのは以下。

1. セッションごとの sandbox ディレクトリ分離
2. sandbox ディレクトリの TTL cleanup
3. session sticky lease による同一 worker 優先実行

一方で、`bash` ツールをそのまま実行する限り、OS レベル隔離がないため「同一 worker 内の他ディレクトリ参照」を完全には防げない。

---

## 1. 目的

1. セッション越境のファイル参照/更新を OS レベルで防止する
2. worker 常駐モデルを維持し、run 起動遅延を実用範囲に保つ
3. platform-agnostic を保ちつつ、Linux 上で実装可能な現実解を示す

---

## 2. 非目的

1. 任意コード実行に対する完全な隔離保証（microVM 相当）を直ちに達成しない
2. すべてのプラットフォームで同一隔離機構を強制しない
3. 既存 run queue/lease モデルを全面的に作り直さない

---

## 3. 脅威モデル

### 3.1 守る対象

1. セッション A の作業ファイルをセッション B から読み書きできないこと
2. ホスト上の機密ファイル（env, secret mount, 他workspace）が参照できないこと
3. 過剰 CPU/メモリ/プロセス生成による worker 妨害を抑えること

### 3.2 想定攻撃

1. `bash` 経由の `..` 移動、絶対パス参照、シンボリックリンク悪用
2. `/proc` / `/sys` / `/dev` 経由の情報取得
3. fork bomb や巨大出力によるリソース枯渇

---

## 4. 要件

### 4.1 セキュリティ要件

1. run 実行時の root filesystem 可視範囲を session sandbox + 最小ランタイムに限定する
2. session sandbox 外への書き込みを禁止する
3. 権限昇格に繋がる capability を削除する
4. 可能ならネットワークをデフォルト無効（必要時のみ許可）にする

### 4.2 性能要件

1. worker 常駐を前提にする
2. run ごとの隔離セットアップ遅延は p95 で許容範囲（目安: 数十ms〜数百ms）に抑える
3. DB lease 更新間隔に対して十分短い起動時間を維持する

### 4.3 運用要件

1. ローカル開発で再現できる
2. docker/k8s/VM いずれでも適用可能な経路を持つ
3. feature flag により段階導入・ロールバック可能

---

## 5. 候補手法比較

| 手法 | 分離強度 | 実行オーバーヘッド | 導入難易度 | 備考 |
|---|---|---:|---:|---|
| アプリ層 path ガードのみ | 低 | 低 | 低 | `bash` 併用時に越境防止が不十分 |
| `bubblewrap` (`bwrap`) | 中〜高 | 低〜中 | 中 | Linux で現実的。run 単位で mount/ns 分離 |
| `nsjail` | 高 | 中 | 中〜高 | seccomp/cgroup 含めた制御がしやすい |
| run ごと別コンテナ | 高 | 中〜高 | 高 | 起動コスト/運用複雑度が上がる |
| microVM (Firecracker など) | 非常に高 | 高 | 非常に高 | 本 spec の初期対象外 |

---

## 6. 推奨方針（段階導入）

### Phase A: 直近の安全側デフォルト

1. `prod` では raw `bash` 実行を禁止（または明示 opt-in）
2. `bash` を許可する場合も隔離ランナー経由を必須化
3. 既存 session-dir + TTL + sticky を運用継続

### Phase B: run 単位 `bwrap` 隔離（第一候補）

1. run ごとに `bwrap` 子プロセスを起動
2. session dir のみを writable mount
3. `/proc` は最小構成で read-only
4. `--unshare-net` をデフォルト（必要時 flag で解除）
5. capability drop / `no_new_privs` を有効

### Phase C: `nsjail` プロファイル（強化オプション）

1. seccomp/cgroup 制約を組み合わせてリソース制限を強化
2. 高セキュリティプロファイルのデフォルト候補を評価

### Phase D: run ごと別コンテナ（高隔離モード）

1. マルチテナントや高機密用途で選択可能にする
2. 起動時間と運用コストを許容できる環境でのみ採用

---

## 7. 実装プロファイル案

### 7.1 モード

- `logical`（現行に近い、開発向け）
- `bwrap`（推奨）
- `nsjail`（強化）
- `container`（高隔離）

### 7.2 設定キー案

- `CODELIA_SANDBOX_MODE`
- `CODELIA_SANDBOX_ROOT`
- `CODELIA_SANDBOX_TTL_SECONDS`
- `CODELIA_SANDBOX_NETWORK` (`disabled` / `enabled`)
- `CODELIA_SANDBOX_CPU_LIMIT`
- `CODELIA_SANDBOX_MEMORY_LIMIT_MB`

注記: キー名は最終実装時に調整してよい。

---

## 8. `bwrap` 実行イメージ（概念）

```bash
bwrap \
  --die-with-parent \
  --new-session \
  --unshare-all \
  --unshare-net \
  --ro-bind /usr /usr \
  --ro-bind /bin /bin \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --proc /proc \
  --dev /dev \
  --bind "$SESSION_DIR" /workspace \
  --chdir /workspace \
  env -i PATH=/usr/bin:/bin sh -lc "$COMMAND"
```

この例では `/workspace`（= session dir）以外への書き込みを許さない構成を想定する。

---

## 9. 観測性・監査

1. run ごとに `sandbox_mode`, `worker_id`, `session_id`, `sandbox_root`, `exit_code` を記録
2. 拒否イベント（policy violation）は専用イベント種別で記録
3. TTL cleanup 件数と失敗件数をメトリクス化

---

## 10. 受け入れ条件

1. セッション A からセッション B の作業ディレクトリを読めない
2. sandbox 外への書き込みが拒否される
3. 隔離有効時でも run 実行が許容遅延内で動作する
4. worker 再起動・複数 worker 環境でも run 整合性が維持される

---

## 11. 未解決事項

1. ネットワーク許可をツール単位で切るか、run 単位で切るか
2. `read/write/edit` と `bash` で同一ポリシーをどう担保するか
3. 非 Linux 環境での等価手段（開発体験の差分許容範囲）

---

## 12. 関連仕様

- `docs/specs/agentic-web.md`
- `docs/specs/permissions.md`
- `docs/specs/tools.md`

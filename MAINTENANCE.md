# metyatech/opencode — カスタムビルド メンテナンスガイド

> このリポジトリは [anomalyco/opencode](https://github.com/anomalyco/opencode) の fork です。  
> GitHub Copilot のプレミアムリクエスト過剰消費バグ（Issue #8030）の修正を先行適用したカスタムビルドを使用するためのものです。

---

## なぜこの fork を使っているのか

OpenCode を GitHub Copilot プロバイダーで使う際、ULW（Ultrawork Mode）のサブエージェント並列展開が
内部ツールコールを `x-initiator: user` として誤送信してしまい、Copilot プレミアムリクエストを
実際の数倍消費するバグ（Issue #8030）があります。

upstream の PR #8721 はマージ未済みのため、このブランチで先行適用しています。

**適用したブランチ:** `fix/copilot-synthetic-detection`  
**変更ファイル:** `packages/opencode/src/plugin/github-copilot/copilot.ts`  
**変更内容:** `detectAgent()` + `SYNTHETIC_PATTERNS` によるシンセティックメッセージ検出

---

## 現在使っているバイナリの確認

新しいターミナルで：

```powershell
opencode --version
# → 0.0.0-fix/copilot-synthetic-detection-YYYYMMDDHHSS  ← これが出れば自前ビルドOK
```

公式版が出てしまう場合は PATH を確認：

```powershell
Get-Command opencode | Select-Object -ExpandProperty Source
# → D:\ghws\opencode\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe  であるべき
```

---

## upstream の更新を取り込む手順

```powershell
cd D:\ghws\opencode

# 1. upstream の最新を取得
git fetch upstream dev

# 2. 自分のブランチをリベース
git rebase upstream/dev
```

**コンフリクトが出た場合**（`copilot.ts` が upstream で変更されていたとき）:

```powershell
# コンフリクト箇所を確認
git status

# packages/opencode/src/plugin/github-copilot/copilot.ts を開いて確認
# → 自分の変更は以下のブロック。これを保持して upstream の変更とマージする：
#   - const SYNTHETIC_PATTERNS = [...]
#   - function isSyntheticText(...)
#   - function hasSyntheticContent(...)
#   - function detectAgent(...)
#   - function detectVision(...)
#   - auth.loader.fetch 内の iife ブロック（detectAgent/detectVision 使用箇所）

git add packages/opencode/src/plugin/github-copilot/copilot.ts
git rebase --continue
```

### PR #8721 が upstream にマージされた場合

```powershell
# ブランチを確認
git log upstream/dev --oneline | Select-String "synthetic\|copilot.*premium\|8721"

# マージ済みであれば自分のパッチは不要になる
# → upstream/dev に切り替えて再ビルドするだけでよい
git checkout upstream/dev
git checkout -b fix/copilot-synthetic-detection  # ブランチ名は維持してOK
```

---

## 再ビルド手順

```powershell
cd D:\ghws\opencode

# 依存関係（package.json が変わった場合のみ必要）
bun install

# ビルド（毎回実行）
bun run packages/opencode/script/build.ts --single

# 確認
& "D:\ghws\opencode\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe" --version
```

ビルド成果物: `packages/opencode/dist/opencode-windows-x64\bin\opencode.exe`

---

## 自動更新について

**カスタムビルドは自動上書きされません。**

OpenCode は起動 1 秒後に更新チェックを実行しますが、インストール方法を `execPath` から自動判定します。  
カスタムビルドのパスはどのパッケージマネージャーにも該当しないため `method = "unknown"` となり、  
アップグレード処理が早期リターンされます（`upgrade.ts`: `if (method === "unknown") return`）。

念のため `~/.config/opencode/opencode.json` に以下を追加しておくと完全に無効化できます：

```json
{
  "autoupdate": false
}
```

---

## 別の PC へのセットアップ

```powershell
# 1. ghws workspace のルートで実行
cd D:\ghws   # または他PCのワークスペースルート

# 2. fork をクローン
git clone https://github.com/metyatech/opencode.git
cd opencode

# 3. upstream を追加
git remote add upstream https://github.com/anomalyco/opencode.git

# 4. 修正ブランチに切り替え
git checkout fix/copilot-synthetic-detection

# 5. Bun 1.3.11+ をインストール（未インストールの場合）
#    https://bun.sh/docs/installation
#    Windows: winget install Oven-sh.Bun

# 6. ビルド
bun install
bun run packages/opencode/script/build.ts --single

# 7. PowerShell プロファイルに PATH を追加
$binDir = "$PWD\packages\opencode\dist\opencode-windows-x64\bin"
Add-Content $PROFILE "`$env:PATH = '$binDir;' + `$env:PATH"

# 8. 新しいターミナルを開いて確認
opencode --version
```

**Mac / Linux の場合**、ビルド成果物のディレクトリ名が変わります：

| OS | バイナリパス |
|---|---|
| Windows x64 | `dist/opencode-windows-x64/bin/opencode.exe` |
| macOS Apple Silicon | `dist/opencode-darwin-arm64/bin/opencode` |
| macOS Intel | `dist/opencode-darwin-x64/bin/opencode` |
| Linux x64 | `dist/opencode-linux-x64/bin/opencode` |

---

## GitHub Copilot との連携設定

このカスタムビルドを使う主な目的は GitHub Copilot プロバイダーへの切り替えです。

```powershell
# 初回認証（OpenCode TUI 内で）
opencode
# → /connect → "GitHub Copilot" を選択 → ブラウザで認証
```

`~/.config/opencode/opencode.json` に以下を設定：

```json
{
  "autoupdate": false,
  "providers": {
    "github-copilot": {
      "disabled": false
    }
  }
}
```

---

## リポジトリ情報

| 項目 | 値 |
|---|---|
| Fork URL | https://github.com/metyatech/opencode |
| 作業ブランチ | `fix/copilot-synthetic-detection` |
| Upstream | https://github.com/anomalyco/opencode |
| Upstream のデフォルトブランチ | `dev` |
| 修正対象バグ | Issue #8030, PR #8721 |
| 修正ファイル | `packages/opencode/src/plugin/github-copilot/copilot.ts` |

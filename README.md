# Waon

ボタンを押している間、和音が鳴るアプリです。

## デモ

ブラウザで試せます: https://gadget114514.github.io/waon/

## 開発

```bash
npm install
npm run dev      # 開発サーバー
npm run build    # dist/ に本番ビルドを出力
npm run preview  # ビルド結果を確認
```

## デプロイ

`main` ブランチへの push で `.github/workflows/pages.yml` が走り、GitHub Pages に公開されます。
初回のみ、リポジトリの Settings → Pages → Build and deployment の Source を **GitHub Actions** に設定してください。

## Android

Capacitor を使っています。

```bash
npm run cap:sync   # ビルドして Android プロジェクトに反映
npm run cap:open   # Android Studio で開く
```

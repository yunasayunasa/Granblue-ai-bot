# ベースイメージとして公式のNode.jsイメージを使用 (LTS版推奨)
FROM node:18-alpine

# アプリケーションディレクトリを作成
WORKDIR /usr/src/app

# package.json と package-lock.json をコピー
# ワイルドカード(*)で両方コピー (package-lock.json がなくても動作)
COPY package*.json ./

# 依存関係をインストール (本番用のみ)
RUN npm ci --only=production

# アプリケーションのソースコードをコピー
COPY . .

# データディレクトリを作成し、Nodeユーザーに権限を付与 (重要！)
# ここで指定するパスは永続ディスクのマウントポイントと合わせる
RUN mkdir -p /data/botdata && chown -R node:node /data/botdata

# コンテナ実行ユーザーを node に変更 (セキュリティ向上)
USER node

# アプリケーションを実行するコマンド
CMD [ "node", "index.js" ]
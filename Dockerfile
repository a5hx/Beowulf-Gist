FROM node:20-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@gist/server..."
ENV NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "--filter", "@gist/server", "start"]
